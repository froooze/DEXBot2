# Fill-authoritative guard and one-counter-per-fill plan

> **Status:** implementation plan (not a change record). Recorded 2026-11-27 from a
> live market-pair bot's fill burst and the current order-engine contracts.
> Generic terms only — no market, pair, account, bot or order id is named.
>
> **Decisions (operator):**
> 1. Every fill represents the market. No fill is "off-market"; fills are
>    authoritative for the last-fill guard, the boundary crawl and the anchor.
> 2. Every filled slot owes exactly one counter order on the opposite rail.
>    Sizing stays fund-driven from the side budget — no per-fill reserved
>    proceeds (the "pair ledger" stays rejected, retrospective §9.9).
> 3. Three in-memory observability counters are landed with the change.
> 4. At most `gapSlots + 1` counter orders are stacked into the grid per cycle;
>    the remainder stays owed for later cycles.
>
> **Current state (follow-up cleanup):** Stages 0–1 below are kept as the
> original plan and are **superseded** by a later cleanup. The compatibility
> surface they retained is now removed: `offMarketFill`, `fillOutsideMarket`,
> `verifyFillMarketReference`, `resolveFillMidVerifyMs`, the refused-level
> helpers and `RefusedFillLevel` type, the `force`/`didRead` branch of
> `maybeRefreshLiveMarketPrice` and the `_fillMidVerifyAttemptedAt` field no
> longer exist. `TIMING.LAST_FILL_MID_VERIFY_MS` /
> `LAST_FILL_MID_VERIFY_TIMEOUT_MS` and their timing-policy entries are gone;
> `deriveTargetBoundary` no longer accepts `isFillEligibleForCrawl`. The
> market-bound `GRID_LIMITS` knobs are removed from the defaults (generated bot
> profiles may still carry the legacy keys as inert data); `LAST_FILL_PIVOT_TTL_MS`
> stays, and `LAST_FILL_REFUSED_LEVEL_TTL_MS` is retained only because the
> historical log-replay analysis still buckets old refusal events by it.

## Source incident (generic)

A taker swept a cheap rail in ~2 minutes (46 fills). The cached book mid had
spiked far above the window, so every fill was classified as a crossed-book
artifact or a premium sweep. `setLastFillPivot` refused them, the crawl and the
re-anchor excluded them, and boundary stayed behind the sweep. The counter
levels (`SELL fill at slot s ⇒ counter BUY at s − gapSlots`) were stranded in
the gap/sell band, so only a few counter rotations were placed. Refused-level
markers additionally blocked same-level re-places, and deferred/rejected COW
cycles delayed the rest.

## Why the design changes

`offMarketFill` is the single definition of "off-market" (retrospective §9.9).
Its veto is the root of the incident: a cached mid — not the fill — decides
whether a real trade may move the guard and the geometry. The operator decision
removes that comparison entirely. Consequences:

- The forced live-mid re-read before a veto (`verifyFillMarketReference`), its
  pacing/timeout knobs, and the whole refused-level marker family become dead.
  The direction rule (equal counts as blocked) is once again the sole
  same-level protection.
- `isCrawlEligible` and the re-anchor extremum filter collapse to "always true".
- The risk that remains is bad **fill evidence** (a crossed-book artifact, a
  misplaced own order, an orphan attribution) becoming authoritative. The
  remaining safety story is the boundary validator and its strictly-fewer
  strand repair, on-ladder price checks, the direction rule and final gate,
  pending crawls, refill-hold/rail clamp, the cross-chunk crawl cap, fill
  dedupe, the 24 h pivot TTL and the bounded generation exit.

## Stages

### Stage 0 — fills become authoritative (SUPERSEDED by the cleanup above)

`modules/order/utils/system.ts`: `offMarketFill` returns `null`;
`verifyFillMarketReference` is a no-op. Gate: replay the incident window —
pivot follows fills, no markers written, no forced book RPC. Stop if a counter
BUY is blocked by the newly armed pivot; fix counter selection first.

### Stage 1 — remove the dead machinery (SUPERSEDED by the cleanup above)

Remove all live call sites of `verifyFillMarketReference` and the single
`offMarketFill` predicate. Delete the refused-level marker family (writer,
readers, release, generation-key branch, bypass denials, manager and type
fields), `isCrawlEligible` and the injected crawl predicate, the gap-band and
market-bound legs of anchor/pivot eligibility, the one-per-cycle re-anchor
budget, `fillOutsideMarket`, the forced-mid-verify branch and its timing knobs,
and the market-bound `GRID_LIMITS` defaults. `LAST_FILL_REFUSED_LEVEL_TTL_MS`
stays only because the offline analysis tool still reads it for historical log
replay. Keep `LAST_FILL_PIVOT_TTL_MS`.
Gate: no live references remain; tests assert absence of the removed exports
and parameters; typechecks green.

### Stage 2 — quota ledger, batch-size stacking and counters

- In-memory `Map<fillKey, OwedCounter>` on the manager; key from `fillKeyOf`.
  Full fills only. Dust-cancel synthetic fills (`isDelayedRotationTrigger`,
  `skipAnchorUpdate`) and partial residuals owe nothing.
- Counter slot: `s − gap` for a SELL fill, `s + gap` for a BUY fill, nearest
  free rail slot, one distinct slot per fill.
- Force owed counter slots into the active window in `calculateTargetGrid`;
  prioritise them in `pairRotations`. Sizes come from `calculateBudgetedSizes`
  (no reserved proceeds). A zero-size quota slot stays owed.
- **Stacking cap:** emit at most `bot._getGapSlotBatchSize()` (`gapSlots + 1`)
  new counter orders per cycle, oldest debt first; the remainder stays owed
  with a batch-cap reason. The cross-chunk crawl budget and per-broadcast op
  cap stay in force.
- Stamp emitted ops with `counterForFillKey` and carry it into `opContexts`.
- Counters: `counterOrdersOwedCount`, `counterOrdersPlacedCount`,
  `counterDebtSlotsCount`; one batch-summary log line.

### Stage 3 — geometry

Remove gap-band fill skips; keep the edge-pinned exclusion as a documented
exception; replace the one-per-cycle re-anchor budget with one batch-extremum
move. Keep `validatePersistedBoundary`, violation-reducing repair and the
half-window crawl cap. Stop if validator refusals rise.

### Stage 4 — debt lifecycle

Debt survives guard skips, final-gate drops, deferrals, batch-cap truncation
and refused commits. It clears only on confirmed on-chain placement of its
stamped op through `adoptPlacedBatchFromChain` / `recoverRefusedCommit`;
ambiguous adoption keeps it owed. Re-delivery of the same fill replaces rather
than stacks. A partial fill leaves its residual active; when that residual
reaches dust size it is cancelled and the normal rotation path re-fills the
freed slot — neither step mints a counter debt.

### Stage 5 — tests and docs

Rewrite the suites that pin refusals; extend the observability and pipeline
contracts; amend the retrospective sections, `COW_INVARIANTS.md`,
`FILL_PIPELINE.md`, `LOGGING.md`, `GRID_PRICE_INVARIANT.md`,
`docs/architecture.md` and the batch-sizing section of
`FUND_MOVEMENT_AND_ACCOUNTING.md`.

## Non-goals

No reserved proceeds / pair ledger, no cooldown or backoff, no new persisted
row or second writer of a fill fact, no crossing veto, and no *behavioral*
config or TTL change: the follow-up cleanup deleted the now-dead
`LAST_FILL_MID_VERIFY_*` and market-bound `GRID_LIMITS` keys, but
`LAST_FILL_PIVOT_TTL_MS` and the analysis-only refused-level TTL are unchanged.

## Verification

`npm run typecheck`, `npm run typecheck:tests`, `npm run check:any`,
`npm test`, plus `npm run analysis:grid-check` over the incident window.
Regression suites: `test_fill_one_counter_order` and
`test_same_level_refill_check` (rewritten for the quota and direction-only
same-level block), `test_p2_observability_counters`, `test_fill_pipeline_contract`,
`test_stale_grid_hardening`, `test_incident_replay`. Suites that pin refusal
policy (`test_refused_level_refill_block`, `test_fill_mid_verification`,
`test_last_fill_pivot_market_bound`, `test_fill_pivot_verification_contract`)
are rewritten, not kept green unchanged.

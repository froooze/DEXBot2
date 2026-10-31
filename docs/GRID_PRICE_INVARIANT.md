# The Grid-Price Invariant

Status: **implemented; the emission check is BLOCKING**
Last code-reviewed against the v1.6.13 release baseline `1a1ae60c` (2026-10-11).

## The invariant

> **`order.price` for a slot-`idx` order must equal `priceForSlot(idx, genesis)`.**

The genesis `priceLevels` table is the only authoritative source of a slot's
price. A slot id encodes an index; the genesis table turns that index into a
price. Nothing else is a legitimate price for a slot.

This is enforced at grid build/load by `assertSlotPriceInvariant(slot, genesis)`
(`modules/order/utils/math.ts`), called from `modules/order/grid.ts`.

**Historical failure:** that assertion was *never called on the broadcast path*.
Placement args were built from the mutable `slot.price` field, so any code that
wrote `slot.price` — or constructed an order object with its own `price` — could
broadcast a non-grid price, with no comparison against the genesis table on the
way out.

### Not to be confused with two related but weaker checks

| Check | Question it answers | Sufficient? |
|---|---|---|
| `isChainPriceOutOfGrid` | Is the price inside `[levels[0], levels[last]]`? | **No** — bounds, not membership |
| `checkPlacementPriceSanity` (removed) | Is the price within 5% of a market reference? | **No** — different reference, flat threshold |
| `assertSlotPriceInvariant` | Is the price *this slot's* level? | **Yes** — true by construction for a valid order |

The distinction matters because the failure band is wide. With a typical
geometry (`minPrice 1.65x`, `maxPrice 10x` around mid), the configured span is
roughly `[0.196, 3.234]`, while the active window is 20 buy + 20 sell slots —
about `[0.293, 0.357]` at 0.5% increment. **Between the window edge and the
configured bound there is a band where a non-grid price is simultaneously "in
range" (passes every range guard) and "not a valid slot" (violates the
invariant), with no check in between.** Range guards cannot see it; only a
grid-membership check can.

## Why this guard exists

`isChainPriceOutOfGrid` answers "is the price inside the configured range?", not
"is it *this slot's* level?" — so a non-grid price can sit inside the range and
pass every range guard (see the band explanation above). Historically the engine
held two sources of truth for a slot's price: the genesis ladder and the mutable
`slot.price` field written from chain data. The mutable field repeatedly won —
orphan adoption stored the chain price, the COW `CREATE` path re-broadcast
`liveSlot.price` in place of the planned price, and the fill-guard pivot was
seeded from unanchored fill prices — after which the off-grid price re-entered
the engine as "evidence" and ratcheted.

The guard closes that class by construction: a legitimate order equals its
genesis level, so only a genuinely non-grid price can be rejected. The full
incident trace — the individual writers, the observed ratchet, and the commit
provenance — is preserved in
[ORDER_ENGINE_POST_1.0_RETROSPECTIVE.md](ORDER_ENGINE_POST_1.0_RETROSPECTIVE.md) (Appendix A).

## Enforcement: the six emission sites

Every site that builds a create/update op now runs the invariant check via
`checkGridPriceInvariant` / `reportGridPriceInvariant`
(`modules/order/utils/order.ts`):

| Site | Location |
|---|---|
| `CREATE` | `dexbot_cow_runtime.ts` |
| `UPDATE` (rotation) | `dexbot_cow_runtime.ts` |
| `CREATE-FALLBACK` | `dexbot_cow_runtime.ts` |
| `RECONCILE-CREATE` | `grid_reconcile_internal.ts` |
| `RECONCILE-UPDATE` | `grid_reconcile_internal.ts` |
| `STARTUP-CREATE` | `grid_reconcile_internal.ts` |

**The check fails open on anything unjudgeable** (full fail-open policy in
["This BLOCKS"](#this-blocks) below), so it can only fire on a genuine mismatch
and cannot false-positive on a legitimately wide grid. That property is why it
is safe where the earlier tuned guards were not.

**Not every fix needed an emission site.** The `sync_engine.ts` materialize
path (a CREATE landing after master lost the slot) materializes a *slot*
rather than emitting an op, so the emission check never sees it — it needed
its own fix, deriving both price and order type from the ladder
(`priceForSlot(parseSlotIndex(gridOrderId), genesis)`) and keeping the carried
descriptor price only when there is no genesis ladder to derive from
(migration), warning when it does. `virtualizeOrder`,
`convertToSpreadPlaceholder` and `toRailHolePlaceholder` were audited and
verified identity-preserving, including under the checker.

The correct pattern already existed in the codebase:
`isUnknownFillOrderAdoptable` (`modules/dexbot_fill_runtime.ts`) derives the
index, checks `isChainPriceOutOfGrid`, checks `isSlotInRail`, and requires the
slot be free. **The fill path was the one place that faithfully used the genesis
table; the broadcast and adoption paths did not.** That is the pattern the rest
of the engine should follow, and it is the model for the adoption fix below.

For the rotation `UPDATE`, the check is against **`action.newGridId`** (the
destination slot): a rotation re-prices to the destination's level, so that is
the slot whose genesis price the emitted price must match. Every planner
producer derives `newPrice` from the object `newGridId` names, so the pairing is
consistent by construction.

**The emitted rotation price is derived, not merely checked.** The planner sets
`newPrice = hole.order.price`, a *mutable* slot field, so the emission would
otherwise be only as sound as whatever last wrote that object. The UPDATE path
therefore derives the price with `deriveRotationPrice` —
`priceForSlot(parseSlotIndex(action.newGridId), genesis)` — and uses the planned
price only when there is no ladder to derive from (migration), warning on any
disagreement. The invariant check stays as the backstop for that no-genesis
case. Note this also means the last-fill guard and the gap-evacuation probe
judge the price that will actually be emitted.

The check is self-validating in the strong sense: `checkGridPriceInvariant`
re-derives the expected level from the slot *id* and compares it against the
passed price, so it never validates a price against itself. A producer that
paired a source price with a destination id is caught (13.9% drift in the
fixture), as is a destination hole carrying an already-corrupted price (28%).

### The seventh gate: final pre-broadcast pivot re-check

The per-action LAST-FILL-GUARD rule is direction-only relative to that pivot —
a BUY is blocked at/above it, a SELL at/below it (equal price is a re-place at
the just-filled level). The spread-correction planner applies the SAME predicate
to its candidates before planning, so a correction batch never contains an op
the guard would drop. The predicate takes exactly `(price, type, lastPrice,
lastType)`: there is no size or increment argument, because the old
`pivot ± increment/2` band was what blocked profitable placements.

**What may become the pivot.** Only a real WINDOW trade. EDGE-pinned insurance
fills (grid floor/ceiling) are skipped by `recordLastFilledPrices` via the
shared classifier `collectEdgePinnedFillIds`, matching the crawl's own edge
exclusion: an edge order is static fat-finger insurance, not market movement,
and the pivot is also the absolute geometry anchor for
`reanchorBoundaryFromLastFill` — a rail-edge pivot would teleport the window to
that edge. PARTIAL fills do arm it (a real trade at a real price). The pivot
then survives a grid rebuild: `_resetLastFillPivot` clears it with the
old generation and `rearmLastFillPivotFromMarketFill` re-arms it immediately
from the bot-scoped last-market-fill row, provenance `'fill'`.

*Operational consequence (deliberate):* after an edge fill the affected side
stays vetoed relative to the last WINDOW trade until a window fill (or the 24h
pivot TTL) re-arms it — e.g. a floor insurance BUY does not license selling that
inventory below the last window sale. Moving the geometry to the edge instead
(the pre-fix behaviour) re-typed and cancelled the whole window on a wick.

The per-action LAST-FILL-GUARD checks run against the pivot frozen at batch
start. A fill queued between that freeze and the broadcast passes every
per-action check on a stale pivot and ships (live incident: freeze at 0.745,
sell fill queued at 0.765, batch broadcast at 0.910 — the violating rotation
filled 6s later, 0.6% below the true threshold). `runFinalPivotGate`
(`modules/dexbot_cow_runtime.ts`) closes that window: after the op-building
loop and immediately before broadcast it re-refreshes the pivot (peek-only,
never drains the fill queue) and, if it changed, re-runs the guard against
every BUILT op:

- an unchanged pivot is a pure no-op; violators drop into the existing
  skipped-slot restore paths (dropped rotations restore from master, dropped
  creates count toward the boundary-hold intersect), so the summary reports
  them as skipped, not passed;
- cancel and size-update ops are never gated; bypass parity with the build
  loop (spread-correction CREATEs, stamped gap-evacuation UPDATEs);
- it fails open on anything unjudgeable — unresolvable price/type, cold pivot,
  a refresh throw — the same policy as the emission guard;
- lockstep compaction remaps the stored pending-broadcast indexes (old→new),
  so a dropped CREATE cannot leave the uncertain-broadcast reconcile adopting
  a matched chain order into the wrong slot.

Tested by FG-1..11 (`tests/test_final_pivot_gate.ts`), including the incident
replay (FG-2) and the index-remap hygiene (FG-7/FG-11).

### The pivot rides the grid snapshot

The guard reads `_lastFilledPrice`/`_lastFilledType`, so the pivot must be live
before the first decision of a run — including while the boundary is still
being rebuilt. Without a persisted row the guard starts every process cold, and
the startup book seed (`seedLastFilledPricesFromBook`, max resting buy / min
resting sell) is only a proxy: it goes wrong whenever the book is not adjacent
to the last fill (partials, rotations, reserve shelf, dust).

`persistGridSnapshot` therefore writes a `{price, type, fillsAt, genesisHash}`
row alongside the grid (`storeMasterGrid`'s `lastFillPivot` parameter, written
under the bot's persistence lock), and `loadGrid` restores it via
`restoreLastFillPivot` right after `_restoreBoundary` — with the grid re-typed
and genesis applied, before the first reconcile/broadcast — so startup,
price-match resume, and the recovery reload all inherit one call site.

Rules that keep the mirror honest:

- **The manager's in-memory pivot stays authoritative at runtime.** The row is a
  mirror that rides the grid snapshot, so it invalidates in lockstep with the
  boundary/genesis instead of forming a second ledger (the `_pendingFillCrawls`
  lockstep contract).
- **Provenance gates persistence.** One writer, `setLastFillPivot(type, price,
  'fill' | 'book')`; only `'fill'` is persist-eligible, so a book seed never
  fossilizes as market truth. One shared shape gate (`normalizeLastFillPivot`)
  serves the snapshot sanitizer and the loader, so the two checks cannot drift.
- **Restore validates before it re-arms**, in order: TTL (24h,
  `GRID_LIMITS.LAST_FILL_PIVOT_TTL_MS`, with the ORIGINAL `fillsAt` preserved
  through `setLastFillPivot`'s `atMs` so it keeps meaning "age of the last
  fill", not "time since last restart") → genesis binding (a row from a dead
  generation is refused) → on-grid (the runtime's own `resolveOnGridPivot`
  ladder validator, reused from `utils/system.ts`, so the restorer can never
  accept a value the live guard would refuse per probe). TTL and
  genesis-mismatch verdicts erase the row through one shared drop path
  (`AccountOrders.clearPersistedLastFillPivot`); an off-ladder row is a no-op
  that falls back to the book seed. The snapped ladder level is restored, never
  the raw float.
- **The generation wipes the pivot.** `initializeGrid` and
  `rejectCorruptedGridSnapshot` call `resetLastFillPivot`, which clears the
  full scalar family including the per-side mirrors (so the book seed's cold
  gate is not silently suppressed by a stale mirror), and `AccountOrders.clearGrid`
  drops the persisted row with the snapshot.

Tested by LFP-1..8 (`tests/test_last_fill_pivot_persistence.ts`) for the
store/load round-trip shape gates, null-clears vs undefined no-ops, the
provenance gate, `fillsAt` preservation, TTL and genesis-mismatch erasure, and
off-ladder refusal.

### This BLOCKS

`recordGridPriceInvariantCheck` / `reportGridPriceInvariant` return whether the
caller may emit. On a genuine off-grid price the emission is **skipped** (the
slot is marked skipped so the next reconcile cycle re-plans), the per-site
warning names the slot, expected level and drift, and the batch summary reports
the aggregate.

The guard **fails open on anything it cannot judge** — no genesis (pre-genesis
startup), unparseable or synthetic slot ids, out-of-ladder indices, non-finite
prices, and any checker exception all permit the emission. A guard that blocked
on missing metadata would halt legitimate trading, which is worse than the bug
it prevents. Only `off-grid-price` blocks.

That fail-open property is what makes blocking safe where the earlier tuned
guards were not: a legitimate order always equals its genesis level by
construction, so a rejection can only mean the price was written from something
other than the ladder.

## Adoption: accept the chain price, don't adopt it

Adoption must accept a chain price that differs from the genesis level. That is
**not** a reason to write it into `slot.price`. Two different prices are
conflated here:

| Price | Meaning | Must equal a genesis level? |
|---|---|---|
| `order.price` | resting limit price on chain | **Yes** |
| `fill.price` | execution price of a fill | **No** — may be better |

A fill can execute better than its resting price, and a partial fill leaves the
order resting at its original price. So `fill.price != order.price` is normal
and is not corruption.

The real adoption case is **grid regeneration**: the grid is recentered but old
chain orders keep resting at the *old* grid's levels. With `incrementPercent
0.5%`, a resting order at `0.32667340` sits a fraction of a slot from the new
grid's `slot--17` at `0.32685210` — a `0.0547%` difference. Correct handling:
adopt into `slot--17` (via `slotIndexForPrice`) and **let the slot keep
`priceForSlot(-17)`**. The old price is chain metadata about where the order *was
placed*; it is not the slot's price, and it disappears on the next
rotation/cancel.

This is what `adoptChainOrderIntoSlot` does — it sets `orderId`, `state`,
`size`, `rawOnChain` and **never touches `price`**. It used to be stated on two
paths (the no-genesis legacy fallback got it wrong); the legacy path is gone, so
there is now exactly one adoption path.

**The rule is stated explicitly, and warns when it is broken.** Keeping the
slot's price by *not assigning it* is correct but invisible: nothing would catch
a later edit that reintroduced `price: chainOrder.price`, and nothing would
catch a slot whose price was **already** corrupted before it reached adoption —
it would simply be re-adopted. `adoptedSlotKeepsItsOwnPrice` runs on adoption
and warns, naming the slot, expected level and drift, when an adopted slot's
price is not its genesis level. A manager with no ladder is a fault, not a
pass: the check reports it rather than waving the adoption through.

That check is deliberately **non-blocking**: the chain order is real and must be
tracked, so refusing the adoption would strand it untracked on the book —
strictly worse than the corrupt slot it reports. It is a signal, not a gate.

ADOPT-001 pins the rule on the nearest-slot path with a resting price that is
clearly off the level, and ADOPT-NAME-001 pins that a correct adoption does not
warn.

## Healing a pre-existing off-grid slot price

The emission guard rejects an off-grid price, so a slot that *persists* one is
rejected on every cycle — a durable stall. `loadGrid` therefore **repairs** any
slot whose price disagrees with its genesis level, in both validation modes
(`modules/order/grid.ts`, at the genesis validation loop):

- the slot's price is set to `priceForSlot(idx, genesis)`;
- enforce mode still virtualizes it (`state: VIRTUAL`, `size: 0`, `orderId: ''`);
- both modes log the correction, naming the slot and the old → new price.

This is safe because **the slot id determines its price from the ladder**: no
legitimate slot can disagree with its own level, so there is no correct value
being overwritten. Before this, the mismatched price was preserved in *both*
modes, which meant a corrupt price survived a restart, re-activated into a
CREATE, and was rejected forever — the guard would have converted a corruption
bug into a permanent one.

Verified: a slot corrupted to 5% off its level is repaired in log and enforce
modes, and the repaired price passes the emission guard (otherwise the stall is
not actually healed). Mutation-checked: reverting the price assignment fails the
assertion.

### After a repair: expect one churn cycle

A repair changes `slot.price`, so any *resting* order still sitting at the old
corrupt price now maps to a different ladder level than its slot. Pass 1 queues
it as a price mismatch and the correction re-prices it onto the slot, so **one
cycle of churn after a repair is expected, not a new fault**. Operators seeing
a burst of corrections immediately following a `[GENESIS] Slot … price repaired
from genesis` line are watching the repair settle.

### Repair only runs at load — so a persistent rejection escalates

`loadGrid` heals on reload, but an in-process corruption has no reload to wait
for. The recurring planner carries the slot's price straight from
`manager.orders`, so a corrupted slot is re-planned, rejected, and warned on
every cycle, forever. Nothing heals it short of a restart: the slot is dead
while the bot looks healthy, and the repeated warns train operators to ignore
them.

The guard therefore **counts consecutive rejecting batches per slot** and, after
`GRID_PRICE_INVARIANT_RESYNC_THRESHOLD` (3) of them, fires
`requestStructuralGridResync('grid-price-invariant-violation', {slotId, expected,
actual, site, streak})`. The resync is the same debounced, batch-in-flight-aware,
two-step (reload → full reset) path already used by the grid-bloat and
spread-stale detectors — a second repair mechanism would duplicate tested
machinery for no benefit. A dedicated
`GRID_PRICE_INVARIANT_RESYNC_COOLDOWN_MS` (15 min) bounds repeats, and a **clean
check clears the streak** so escalation means "rejected N *consecutive* batches",
not "rejected N times ever".

**Why not heal in place** (`slot.price = expected` at rejection time): the
checker does compute the right value, but silently rewriting it destroys the
diagnostic signal. The streak is what distinguishes the corruption sources —
a pre-ladder snapshot, the ladder-migration cross-check, a genesis-identity
mismatch, or an unknown live writer. Auto-heal makes them all look identical.
Count first, escalate on persistence; consider an in-place fast path only after a
soak shows in-process corruption is the common case.

The streak is **bot-scoped**, not module-scoped: the monolithic runtime
(`dexbot.ts`) runs every active bot in one process, so a shared count would pool
unrelated bots' rejections — one bot's two rejections would put the next bot at
the threshold on its first rejection and fire a spurious structural resync on a
healthy bot (verified by GPI-WIRE-007/008).

## Out-of-bounds policy: hold, and surface

**Decision: hold indefinitely, and warn.** Holding costs opportunity; wrong
placements cost capital. The grid geometry is not invalidated by the market
leaving it — every observed violation was on the *placement* side, not the
resting grid.

| Event | Action |
|---|---|
| Market moves beyond configured bounds | Keep the grid as-is. Do not recenter, rescale, or extend the boundary. |
| Chain order exists outside the grid range | Hold untouched (`out-of-grid-deferred`). Do not adopt, do not cancel. |
| Fill occurs while out of bounds | Apply its accounting; do **not** let its price become grid evidence. |
| A slot *inside* the grid empties | Refill at `priceForSlot(idx)` — **this continues even out of bounds.** |
| An order would need a non-grid price to "keep up" | Do not place it. |

The last two rows are the point: refilling an emptied slot at its genesis price
is always valid (the slot's price is still a grid price). What must stop is
emitting orders whose price is not a grid price.

Holds are classified non-blocking by `isNonBlockingUnmatchedOrder` (any
`*-deferred` reason), so they do not force a grid reset while they persist.

### Hold observability

The `[HOLD]` line names side, price, size, reason, and distance from the nearest
grid bound (as a percentage, so a near-miss is distinguishable from a
deliberately-placed far order). An unchanged set is re-warned slowly
(`TIMING.STALE_TOTALS_WARN_RATE_LIMIT_MS`), because "held indefinitely" must not
be indistinguishable from "bot silently stuck".

The gate is content-based, not count-based: same-count churn (one hold clearing
as another appears) previously looked like "no change" and was never logged.

The signature is also the **logging gate**, but it is NOT the staleness clock.
Age is measured **per stranded order** (`id@price/size:reason`) from the first
cycle that order was seen stranded, tracked in a bot-scoped map. Two earlier
choices were wrong, and each was caught by a test that now pins it:

1. `manager._lastUnmatchedChainOrdersAt` records "when we last looked", never
   "when the hold started" — an age gate on it could never fire (HOLD-007).
2. The whole-held-set signature clock looked correct but was **reset by
   unrelated churn**, because the signature includes every entry's reason. An
   unrelated hold flapping in and out changed the signature every cycle and
   restarted the clock, so a genuinely stranded order was starved of escalation
   forever (HOLD-010). A per-order clock is immune: age belongs to the order,
   not to the set.

A third defect sat in the same path: the signature-change branch used to
`return` before reaching the escalation call, so any churn skipped escalation
entirely. Escalation is now invoked on BOTH branches — a signature change is a
reason to re-log, not a reason to stop evaluating age.

When a stranded hold reaches `DEFERRED_HOLD_ESCALATE_MS` (24h) it escalates at
`error` and fires the same `requestStructuralGridResync('deferred-hold-stale',
...)` — the exit that a per-cycle hold-and-warn loop otherwise lacks.

Only genuinely **stranded** reasons are escalation triggers. Escalation uses a
narrow allow-list (`isStrandedHoldOrder`: `out-of-rail-deferred`,
`out-of-grid-deferred`) rather than the broad `-deferred` non-blocking filter.
A resync cannot end a broadcast region or re-evaluate an uncommitted boundary,
so `broadcast-active-deferred`, `boundary-hold-trailing-market`,
`boundary-unknown-deferred` and `held-plan-unchanged-deferred` are excluded:
escalating on them would spend a full grid reload on something the owning
machinery already resolves. The allow-list fails closed, so a future transient
reason is excluded by default instead of silently becoming a resync trigger
(HOLD-011).

That escalation is safe because the full reset's reconcile is **update-first**:
unmatched chain orders are price-updated onto rail slots (emitting the rail's
genesis level, so the RECONCILE-UPDATE guard does not block the resolution) and
only true surplus is cancelled. Funds are released by price-updating, not by
inventing a new cancellation policy. A dedicated
`DEFERRED_HOLD_RESYNC_COOLDOWN_MS` (6h) bounds repeats.

### Known limitation: no market-aware "left the bounds" signal

The hold is per-order and reactive: the bot cannot distinguish "one stray
order outside the range" from "the market left the range entirely", so it
cannot warn *before* orders become stranded. The earlier anchor/divergence
constants (`ANCHOR.DIVERGENCE_INFO`, `DIVERGENCE_WARN`) were removed with the
anchor itself; only `calculateGridSideDivergenceMetric` survives, used for
side-divergence metrics in `grid.ts`. Until a market-aware signal exists, the
24h escalation fires on a timer rather than on cause — whether the market left
the bounds or one order is simply stranded, because neither case is
distinguishable from the hold record alone. The blast radius is bounded by
the stranded-reasons allow-list above. The designated home for a real signal
is divergence telemetry built on `calculateGridSideDivergenceMetric`.

## The genesis-less state: refused at load, rebuilt or halted

**A grid with no price ladder is not a degraded grid — it is an undefined one.**
Every consumer of the invariant reads `priceForSlot(idx, genesis)`, and each one
silently degrades without it: nearest-slot adoption, `computeOutOfToleranceDriftTag`,
the materialize descriptor-price fallback, `resolveLiveEdgeAnchorPrice`
tiers 3/4, and the `isSlotInRail` fail-open. That degradation is the tolerance
matcher, which is exactly the path on which an off-grid price becomes grid
evidence. So the ladder is treated as a **required** part of a snapshot, not a
nice-to-have.

The trigger is narrow: only a *pre-v1.4.25* snapshot (one persisted before the
genesis was written) can reach it. Given such a snapshot:

| Trigger | Condition | Verdict |
|---|---|---|
| T1 | config rail matches the persisted slots | migration ladder is adopted (unchanged) |
| T2 | > `MISSING_GENESIS_MISMATCH_RATIO` (50%) of slots mismatch the config rail | **refused** — the config was edited, so the derived rail is a different generation |
| T3 | rail config is not numeric yet (`startPrice: "pool"`, `minPrice: "2x"`) | **refused** — nothing can be built until `initializeGrid` derives them |
| T4 | the ladder build throws | **refused** |

### The decision lives in one place

`modules/order/genesis_policy.ts` owns the single question "can this snapshot
have a ladder?" (`resolvePersistedGenesis`) and the policy
(`resolveOnMissingGenesisPolicy`). Three call sites, one verdict — they cannot
drift:

| Site | Mechanism | What it does on a refusal |
|---|---|---|
| `grid.loadGrid` | **E1**, source choke point | throws `MissingGenesisError` **before any mutation** (no asset init, no fund reset, no boundary restore) |
| `dexbot_startup_runtime` | **E3**, startup gate | regenerates the grid (`initializeGrid` re-derives prices, reconcile is update-first) or aborts startup |
| `order/sync_engine._assertGenesisInvariant` | **E2**, defence in depth | **refuses the sync** (empty result, nothing touched), reports once per generation, counts, and requests a structural resync — never throws |
| `AccountOrders.loadGenesis` | schema | a row with empty/absent `priceLevels` is not a ladder and is not returned |

### Policy

`config.gridLimits.MISSING_GENESIS_POLICY`:

- **`'rebuild'` (default)** — refuse the snapshot and rebuild a clean ladder
  through the existing resync machinery. Deterministic, no operator action, and
  fund-safe in the same sense a manual reset is: reconcile is update-first, so
  only true surplus is cancelled and out-of-grid orders are held per the
  out-of-bounds policy. Live orders are re-slotted — the same net effect the
  operator would get from `dexbot reset`, which is why `'halt'` exists.
- **`'halt'`** — refuse to start; a human must run a manual grid reset. Strongest
  fund safety (nothing is cancelled without consent), but the bot stays down until
  someone acts, which is why it is opt-in.

Anything other than `'halt'` falls back to `'rebuild'`.

### Routing per caller

- **startup resume** — the E3 gate fires *before* the resume/regenerate decision,
  so a ladder-less snapshot is regenerated rather than half-loaded.
- **price-match resume** (`attemptResumePersistedGridByPriceMatch`) — the throw is
  caught and reported as "not resumed", which routes to regeneration.
- **recovery reload** — the throw is caught and logged with its reason. Under
  `'rebuild'` it is returned as a failed reload, which is the existing signal for
  "escalate to structural resync"; under `'halt'` the failure carries `halt: true`
  so the maintenance resync path suppresses the automatic rebuild and waits for
  the operator.
- **runtime E2 assert** — never fatal: it aborts the sync instead of reconciling a grid whose slots have no price authority, and it exists to make a future bypass loud.

Observability is part of the design, not an afterthought: the fault is recorded on
the manager as `_missingGenesis` (reason, detail, mismatch ratio, policy) and
cleared by the next successful load or grid build, so a log read tells an operator
whether T2-T4 ever fire in the wild.

### The tolerance matcher is gone

The consumers listed above no longer degrade, because there is nothing left to
degrade *into*:

| Former legacy behaviour | Now |
|---|---|
| pass-2 tolerance adoption, incl. the widened `ORPHAN_ADOPTION_TOLERANCE_MULTIPLIER` spread-orphan band | nearest-slot only; no ladder means the orphan is reported as `no-genesis-deferred` and nothing is touched |
| pass-1 price-equality / duplicate-swap fallback to `calculatePriceTolerance` | level identity (`chainPriceOnSameLevel`: both prices map to the same slot), integer equality only when unjudgeable; a few-quanta rest-drift within one level is left in place (no re-price) until the order rotates |
| correction-queue staleness matched by tolerance | `priceSlotEqual` against the slot's own level, and a ladder-less entry is dropped |
| `computeOutOfToleranceDriftTag` + `price-drift-orphan` auto-cancel (`PRICE_DRIFT_TOLERANCE_MULTIPLIER`) | removed — an off-grid order is HELD (`out-of-grid-deferred`) and resolved structurally, never cancelled off a fuzzy price diff |
| `findMatchingGridOrderByOpenOrder` | removed (its last production caller was the pass-2 legacy block; the cancelOrder linkage matches by `orderId`) |
| `resolveLiveEdgeAnchorPrice` tiers 2/3 (live slot extreme, config bound) | ladder extreme only; a ladder-less manager returns `null` (the live resolver no longer computes a config bound — consumers that want one, e.g. `edgeOrderIdSet`, resolve it themselves) |
| materialize descriptor-price fallback for a `slot-N` id | kept only for an unparseable id; a `slot-N` id with no ladder logs `error` and requests a structural resync |

**E2 is fail-closed.** `syncFromOpenOrders` calls `_assertGenesisInvariant`
before anything else and, when slots exist without a ladder, returns an empty
result — no locks, no adoption, no correction queued — after logging at `error`
and requesting the structural resync that re-derives the ladder. It used to log
and continue *into* the tolerance matcher; that continuation is what made the
legacy path a live safety net, and it is what this removal gives up. The load
gates (E1/E3) own the fail-closed decision, so the state is unreachable through
a supported flow.

### Rejected alternatives

- **Adopt the config-derived ladder despite a >50% mismatch** (mass-virtualizing
  live tracking and persisting a mismatched genesis) — corruption risk, rejected.
- **Derive the ladder from the persisted slot prices** — a truncated persisted
  array would permanently shrink it.
- **Keep loading "as-is without a ladder"** — this is the state that was removed.
- **Keep the tolerance matcher as the E2 fallback** — it is the corruption path
  the invariant exists to close; E2 refuses instead.

## Key constants (`modules/constants.ts`, `TIMING`)

| Constant | Value | Meaning |
|---|---|---|
| `MISSING_GENESIS_POLICY` | `'rebuild'` | `'rebuild'` (auto) or `'halt'` (manual reset) when a snapshot has no usable ladder |
| `MISSING_GENESIS_MISMATCH_RATIO` | 0.5 | Share of slots that must match the config rail before a migrated ladder is adopted |
| `GRID_PRICE_INVARIANT_RESYNC_THRESHOLD` | 3 | Consecutive rejecting batches per slot before a structural resync |
| `GRID_PRICE_INVARIANT_RESYNC_COOLDOWN_MS` | 15 min | Bounds repeat resyncs for the same corruption |
| `DEFERRED_HOLD_ESCALATE_MS` | 24 h | Age at which a stranded deferred hold escalates |
| `DEFERRED_HOLD_RESYNC_COOLDOWN_MS` | 6 h | Bounds repeat resyncs for stale holds |
| `STALE_TOTALS_WARN_RATE_LIMIT_MS` | 60 s | Slow re-warn interval for an unchanged hold set |

## Implementation status

| Item | State |
|---|---|
| Legacy adoption keeps `slot.price`; gains the rail guard | **landed** |
| Materialize path derives price from genesis, not the descriptor | **landed** |
| Materialize path derives ORDER TYPE from the same ladder level, not the descriptor | **landed** |
| Persistent off-grid rejection escalates to a structural resync (per-slot streak) | **landed** |
| Stale deferred hold escalates to a structural resync (per-order stranded clock) | **landed** |
| Pre-broadcast substitution removed (CREATE) | **landed** |
| Pre-broadcast substitution removed (CREATE-fallback) | **landed** |
| Invariant check at 6 emission sites | **landed — BLOCKING (rejects off-grid emissions)** |
| Fill-guard pivot validated onto the ladder (`resolveOnGridPivot`) | **landed** |
| `[HOLD]` enrichment + slow re-warn | **landed** |
| Final pre-broadcast pivot gate re-checks BUILT ops on a refreshed pivot | **landed** |
| Fill-guard pivot persisted with the grid snapshot (provenance: fills only) | **landed** |
| Snapshot without a usable ladder refused at load; rebuild by default, `halt` opt-in | **landed** |
| Legacy tolerance matcher removed; E2 fail-closed (refuse the sync) instead of warning and continuing | **landed** |
| Pivot restored with the boundary (TTL → genesis → on-grid validation chain) | **landed** |
| Pivot mutation behind one provenance-tagged writer (`setLastFillPivot`) | **landed** |
| Grid generation invalidates the pivot (in-memory + persisted row) | **landed** |

`resolveOnGridPivot` snaps a near-ladder pivot to its slot level but **refuses to
rewrite a far-off-ladder one** onto an edge slot — silently clamping would dress
a corrupt pivot up as a legitimate edge fill. Off-ladder pivots are counted and
reported.

## Verification

- **Unit (GPI-001..015, `tests/test_grid_price_invariant_guard.ts`):** for
  every emitted op, `price === priceForSlot(idx, genesis)`.
  Rotation UPDATEs additionally assert `newPrice` matches the **destination**
  slot's level (GPI-010); an off-grid emission is **refused**, a genesis level is
  permitted (GPI-011); unjudgeable inputs fail open (GPI-012); the emitted
  rotation price is derived from the destination's genesis level (GPI-013), and
  the derivation declines — rather than inventing a price — with no ladder
  (GPI-014) or an out-of-ladder index (GPI-015).
- **Unit:** an out-of-grid order is held, not adopted, and keeps its genesis
  price (ADOPT-001/002); the materialize path derives the slot price AND order
  type from genesis (MATERIALIZE-001/003) and, on a ladder-less grid, still
  tracks the placed order but logs the undefined grid at `error` and requests a
  structural resync (MATERIALIZE-002); adoption keeps the slot's own level and
  does not warn when correct (ADOPT-NAME-001)
  (`tests/test_sync_out_of_grid_defer.ts`).
- **Unit:** pass-2 orphan classification is nearest-slot only — out-of-grid is
  held, an in-grid orphan adopts into the slot its price maps to and keeps that
  slot's level, an occupied level is a cancel-only duplicate, and a ladder-less
  grid refuses the whole sync (`tests/test_sync_excess_orphan.ts`).
- **Unit:** pre-broadcast drift is reported at `warn` and the op is built from
  the *planned* price (`tests/test_cow_orchestration_fixes.ts`).
- **Unit:** pivot snapping and off-ladder refusal
  (`tests/test_last_fill_guard.ts`, PIVOT-001..003); the final pre-broadcast
  pivot gate re-checks BUILT ops on a refreshed pivot, drops violators into the
  skipped-slot restore paths, remaps pending indexes on compaction, and never
  gates cancels or size-updates (`tests/test_final_pivot_gate.ts`, FG-1..11,
  including the 2026-09-13 stale-pivot incident replay).
- **Unit:** pivot snapshot round-trip and its restore validation chain
  (`tests/test_last_fill_pivot_persistence.ts`, LFP-1..8) — shape gates,
  provenance, TTL, genesis binding, off-ladder refusal, full-family reset.
- **Unit:** the missing-genesis policy — T1 adoption, T2/T3/T4 refusals, the
  ratio boundary, policy resolution, `loadGrid` refusing before it mutates
  anything (and honouring `'halt'`), the `loadGenesis` schema gate, and the E2
  sync-entry assert and the `'halt'` suppression of the recovery resync
  (`tests/test_missing_genesis_policy.ts`, GEN-01..21).
- **External gate:** `analysis/grid_correction_check.ts` — target 0 sustained
  violations at 168h/720h. **The baseline is NOT clean:** 4 of 5 bots were
  non-zero over 7 days, so this is a live signal, not a historical one.
- **Live status:** the blocking check has seen live traffic — 75 judgeable
  checks (`site=COW`, `violated=0`, `unchecked=0`) across four live bot logs
  on 2026-09-14. No live **rejection** or **escalation** has been observed
  yet, so the resync thresholds (`GRID_PRICE_INVARIANT_RESYNC_THRESHOLD`,
  `DEFERRED_HOLD_ESCALATE_MS`) remain validated only by mutation tests. The
  first `violated>0` in production should be read as a real writer, not a
  false positive: a legitimate order equals its genesis level by
  construction. Treat the first escalation as a genuine signal about how
  long an in-process corruption actually survives.

Each behavioural fix above is mutation-tested (revert the fix, confirm the test
fails) so the tests are known to discriminate rather than merely pass.

**Emission-site wiring.** The guard's own rules (`checkGridPriceInvariant`,
`reportGridPriceInvariant`) are unit-tested by GPI-001..015, but that says
nothing about whether a live batch *consults* them — a mutation audit found the
three COW sites could be neutralised entirely with every COW test still green.
`tests/test_grid_price_invariant_wiring.ts` (GPI-WIRE-001..009) closes that: it
drives `updateOrdersOnChainBatchCOW` end-to-end with a real DEXBot/OrderManager
and asserts that no op reaches `buildCreateOrderOp`/`buildUpdateOrderOp` and
nothing is broadcast. Mutation-verified: disabling the blocking CREATE check
fails GPI-WIRE-001; reverting the rotation price derivation fails GPI-WIRE-004;
feeding the guard the raw pivot instead of the validated one fails GPI-WIRE-005.
The escalation is pinned by GPI-WIRE-006..009: removing the escalation call,
removing the streak reset on a clean check, and disabling the cooldown are each
caught, and GPI-WIRE-009 pins that the per-slot streak is bot-scoped — the
monolithic runtime runs every active bot in ONE process, so a module-level
streak would let one bot's rejections push another to the threshold on its first
rejection, firing a spurious resync on a healthy bot. The hold escape hatch is
pinned by HOLD-006..011 (`tests/test_hold_and_center_guards.ts`). Three
mutation-verified discriminators: HOLD-007 fails if age comes from
`_lastUnmatchedChainOrdersAt` (the clock that could never fire); HOLD-010 fails
if age comes from the whole-held-set signature clock (reset by unrelated churn,
starving a stranded order forever); HOLD-011 fails if the narrow stranded
allow-list is replaced by the broad `-deferred` filter (transient holds would
spend a grid reload).

**One site is not black-box reachable, by design.** The UPDATE check
(`action.newGridId`) is a backstop: `deriveRotationPrice` computes the emitted
price *from* the destination's genesis level before the check runs, so at the
check the id and price agree by construction. Disabling that check cannot be
caught from outside because there is no reachable input that makes it fire. The
reachable property — that a planner-supplied `action.newPrice` disagreeing with
the destination's level never reaches the chain — is what GPI-WIRE-004 pins.
Treat the UPDATE check as defence for a missing genesis ladder (it fails open
there), not as the only thing standing between a bad plan and a live order.

**False-positive audit (blocking enabled).** Because the check now rejects, it
was audited against real grid builds before enabling: **1,153 slots across five
geometries** — standard, wide (1.65x-10x), tight, wide at 2% increment, and the
incident geometry (1.65x-10x around ~0.32) — produced **zero** off-grid
rejections and zero uncheckable slots. The identity-preserving transforms
(`virtualizeOrder`, `convertToSpreadPlaceholder`, `toRailHolePlaceholder`) also
pass, while an order object carrying its own drifted price is caught (50% drift
in the fixture). That is the evidence that blocking is safe: a legitimate order
equals its genesis level by construction, so only a genuinely mis-priced
emission can be rejected.

## The removed placement gate: do NOT naively re-land

`d808c052` added `checkPlacementPriceSanity` (reject a planned price >5% from a
traded-range mid). It was removed the same day by `e2898e51` because it "blocked
legitimate order creates and updates".

**That framing is misleading, and the code shows the real mechanism.** The
removal was not an over-tuned threshold — it was a **design deadlock**:

- `ANCHOR.PRICE_OUTLIER_FACTOR: 2` bounded the fills considered plausible.
- Out-of-bounds fill prices were then **skipped entirely** by
  `resolveFillPrice` / the burst fill loop.
- But those same fills were what boundary correction needed in order to *update*
  the anchor.
- So after a genuine trend beyond 2x, the correction bound could never be
  re-derived: the guard bounded the very evidence required to correct it.

Hence "too restrictive" describes a design flaw, not a tuning problem. Framing
it as tuning invited the wrong fix — deletion instead of repairing the
unbounded-anchor path. A re-land must address the deadlock, not retune a number.

The violator that ran free once the detector was gone was the **role-assignment
pass inside `calculateTargetGrid`** (`modules/order/strategy.ts`), which re-typed
slots relative to *fill prices* rather than the boundary — with an **unbounded**
BUY→SELL direction (`slot.price > minFilledBuyPrice` has no upper limit). With
`minFilledBuyPrice` inflated by a poisoned fill, every BUY below it flipped to
SELL and was re-created above it: the observed ratchet.

Implication: restoring `checkPlacementPriceSanity` alone would **not** fix that.
Any re-land must fix the out-of-bounds-skip deadlock *and* clamp the rotation
independently of the anchor. See `git show d808c052` for the removed
implementation; the removal provenance (symbol → built → removed) is recorded in
`docs/ORDER_ENGINE_POST_1.0_RETROSPECTIVE.md`.

## Caveats

- Figures (`2.45x`, `~180 slots`, `[0.196, 3.234]`) are derived from typical
  configured multipliers and a representative reference price. Exact levels
  should be read from the persisted grid to confirm.
- The removed-path behaviour was read from `d808c052`/`e2898e51`, not executed.
- No real account names, bot names, or live market pairs are included.

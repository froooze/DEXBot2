# Grid Reconciliation: Distributed State Mismatch in a Single-Threaded Runtime

## The Core Problem

DEXBot2 holds an **intended grid state** — which orders should be on-chain, at what prices and sizes, each assigned a grid slot with an `orderId`. The blockchain holds the **actual state** — the limit orders that physically exist. Fills, partial cancellations, race conditions, and external cancellations or manual order edits cause these to diverge.

| Side | What it holds | Ground truth? |
|------|---------------|---------------|
| **Bot model** (`manager.orders`) | Grid slots with target price, size, state, `orderId` | Optimistic — set before confirmation, updated after broadcast |
| **Blockchain** (BitShares DEX) | Limit orders with ID, price, for_sale, filled | Yes — this is reality |

Reconciliation aligns the bot's model with on-chain reality. It runs at startup when the gap is widest (bot was offline, fills happened, grid may have been regenerated).

### Why Not Cancel Everything

- No atomic cancel+create on BitShares — `limit_order_cancel` cancels the full order; there is no partial size reduction
- A full teardown leaves the bot unable to trade during the rebuild window

---

## Architecture: 3-Phase Plan-then-Execute

The reconcile runs from [`recalculateGrid`](../modules/order/grid.ts) during startup full-resync. **There is no per-attempt wall-clock race around the reconcile itself** — an outer timeout would fire mid-batch and orphan in-flight broadcasts (the duplicate-accumulation death spiral). The reconcile is bounded only by the 10-minute total resync safety net, and every internal chain read follows the shared guarded-read standard.

Phase 1 does all reasoning in memory under `_gridLock` (fast); Phases 2 and 3 execute outside that planning lock — holding it across RPC calls would block fills, sync, and divergence checks. Phase 2 holds the broadcasting single-flight marker, while the sync/apply paths it invokes follow the canonical lock hierarchy. No planning-phase grid lock spans a network operation.

Phase 2 and 3 both respect the `dryRun` flag: when true, no on-chain mutations are attempted — plans are logged but not executed.

`targetCount` (per side, `targetSell`/`targetBuy`) is sourced from bot config (`coreOrders` window plus `edgeOrders` edge ladder) and determines how many live orders each side should maintain. The internal `planOnly` flag controls whether `_reconcileStartupSide` records plans for Phase 2 or executes inline — Phase 1 always calls with `planOnly=true`.

```
                    Grid generated
                            │
                            ▼
┌──────────────────────────────────────────────────┐
│  PHASE 1: Planning (under _gridLock)             │
│                                                  │
│  • Sanitize phantom orders (ACTIVE/PARTIAL with  │
│    orderId absent on-chain → VIRTUAL, skip);     │
│    defer freshly-assigned orderIds, ghost pass   │
│  • Detect suspected duplicates (exact price) →   │
│    queue for Phase 2 cancel                      │
│  • Match unmatched chain orders to virtual slots │
│    → plan updates                                │
│  • Detect grid-edge lockup → plan largest-order  │
│    cancel to free funds                          │
│  • Detect excess chain orders → plan cancels     │
│  • No on-chain RPC calls inside this phase       │
└──────────────────┬───────────────────────────────┘
                   ▼
   returns { plannedCreates, plannedUpdates, plannedCancels }
┌──────────────────────────────────────────────────┐
│  PHASE 2: Execution (outside _gridLock)          │
│                                                  │
│  1. Cancellations — revalidate each plan against │
│     live ownership, geometry, and chain state    │
│  2. Updates — batch (3 retries), then sequential │
│     fallback with per-failure recovery sync      │
│  3. Creates — outside-in pairing (outermost grid │
│     slots first, BUY desc / SELL asc), batched   │
│     where the DEX supports batch creates;        │
│     uncertain lands adopt; created IDs tracked   │
│     for Phase-3 protection                       │
└──────────────────┬───────────────────────────────┘
                   ▼
┌──────────────────────────────────────────────────┐
│  PHASE 3: Fresh Count + Stale Surplus Cleanup    │
│                                                  │
│  • Re-fetch chain state after Phase 2 (guarded)  │
│  • Adopt uncertain-landed creates into VIRTUAL   │
│    slots                                         │
│  • Protect Phase-2 created IDs from surplus      │
│    cancel                                        │
│  • Cancel orders exceeding per-side target not   │
│    tracked by any grid slot's orderId (orphans)  │
└──────────────────────────────────────────────────┘
```

### Phase 1 — Pure Planning Under `_gridLock`

**Source:** `reconcileGridOrders()` Phase 1 in `grid_reconcile.ts`.

1. **Phantom order sanitization** (the `isOrderPlaced()` absence pass in `reconcileGridOrders()`): For each `isOrderPlaced()` order whose `orderId` is not in the chain snapshot, reset it to VIRTUAL with `skipAccounting` to prevent fund inflation. Two absence-decision guards make this safe:
   - **Freshly-assigned deferral** (the `_orderIdAssignedAt` freshness guard): an `orderId` assigned within `TIMING.SYNC_LOCK_TIMEOUT_MS` may be an in-flight create/adopt whose broadcast has not landed or is not yet visible to a lagging/truncated read — virtualizing it and re-creating would duplicate a real live order (the reconcile-timeout death-spiral root cause). It is skipped (deferred) rather than virtualized.
   - **Ghost heuristic** (same absence pass): an order with `size <= 0` && `PARTIAL` (a known filled ghost) still passes through so known fills get cleaned up.
   - Virtualization always uses `{ skipAccounting: true }` so startup cleanup never inflates `ChainFree`.

2. **Duplicate detection** (the unmatched-order duplicate pass): For each unmatched chain order, find the nearest active same-side grid order. If its price equals that grid order's slot price exactly (`priceSlotEqual` at the asset precision), flag it as a suspected duplicate and queue for a Phase 2 cancel (never cancelled under lock). Non-equal neighbours are only logged with nearest-same-side diagnostics and continue into per-side reconciliation. Duplicate IDs are removed from the unmatched set so they aren't also paired for updates/creates.

3. **Per-side reconciliation** via `_reconcileStartupSide(planOnly=true)` (`grid_reconcile_internal.ts`):
   - Count `matchedOnGrid` (active grid orders with `orderId`)
   - `neededSlots = targetCount - matchedOnGrid`; pick virtual slots to activate
   - Match sorted unmatched chain orders to virtual slots → `plannedUpdates`
   - Detect grid-edge lock and plan a largest-order cancel
   - Plan creates for remaining slots
   - Plan excess cancellations (guarded by `matchedOnGrid > 0`): orphans first, then **matched surplus** (`chainCount - targetCount`, edge slots last) — the matched-excess selection is shared by the planOnly and execute branches so planning can never drift from execution; planOnly omits `releaseUntrackedFunds` for matched slots (their funds are tracked on the grid slot)
   - Fork-kept **shelf orders** (live non-slot-N ids below the rail, e.g. `deep-*`) are never cancel candidates or reserve members — see [Shelf Orders](#shelf-orders-fork-kept-manual-orders)
   - **Vacated-rail refill**: each PROCEEDING update whose vacated price exactly matches (`priceSlotEqual`) an empty, sized, in-rail slot of the same side queues a refill CREATE in the same plan (`source startupVacatedRailRefill`) — skipped updates, ghost prices (lattice moved), in-band slots, and already-desired slots never refill; refill targets require VIRTUAL state with no `orderId`

Returns `{ plannedCreates, plannedUpdates, plannedCancels, chainSellCount, chainBuyCount }`.

### Phase 2 — Blockchain Execution Outside Lock

**Source:** `reconcileGridOrders()` Phase 2 in `grid_reconcile.ts`.

Phase 1 releases `_gridLock` before network I/O. Phase 2 runs under the
broadcasting single-flight marker so a fill-driven COW rebalance cannot plan the
same slots concurrently; individual sync/apply paths follow the canonical lock
hierarchy. No planning-phase `_gridLock` is held across RPC calls.

**Cancellations — v1.6.6 stale-plan guard:** Before submitting any
`plannedCancels`, reconcile performs one guarded pre-cancel read and builds a
per-order signature (type, price, size) from both the Phase-1 and current
snapshots. For every plan, `_startupCancelPlanStillCurrent()` requires:

- the target chain order still exists with its exact Phase-1 signature;
- a matched plan still owns the same chain order in the same live grid slot;
- planned type, slot price, boundary, and gap geometry still match; and
- an originally unmatched surplus is still not owned by any live slot.

Validation is per-plan: an earlier cancellation or unrelated order change does
not invalidate an otherwise untouched plan. A truncated or failed pre-cancel
read skips all cancellation submissions. A complete empty read is authoritative
but likewise causes no plans to execute because no target remains present.
This closes stale-cancellation replays without requiring the whole book to
remain unchanged.

**Fresh-placement grace (`TIMING.SURPLUS_CANCEL_GRACE_MS`, 15 min):** surplus
and cancel-only cancellations also skip any order whose `orderId` was placed
inside the grace window. The timestamp is written by `recordOrderPlacement` into
`manager._placedAt` and tested with `isFreshlyPlacedOrder`; the reconciler's CANCEL
actions are filtered by `COWRebalanceEngine.execute`, which drops the whole slot's
action group (a paired CANCEL+CREATE must not lose only its CANCEL, or the CREATE
folds back into an UPDATE and re-materializes the placement) and re-syncs the
deferred slots from master via `workingGrid.syncFromMaster` before commit. The
order stays ACTIVE and is re-drained once the window expires. `grid-load`/
`grid-init` contexts are excluded so a restart does not suppress the sweep.

Surplus settlement uses the same live-ownership decision. Only an order that is
still untracked, signature-unchanged, and outside the fresh-placement grace
window reaches `_cancelChainOrder`; a now-owned or geometry-changed order is
skipped rather than released from the stale snapshot.

**Updates:**
- Batch via `_executeStartupUpdateBatch` when `supportsBatchUpdate` is available
- Retry up to 3× (`maxBatchAttempts = 3`)
- On each failure: `_recoverStartupSyncFailure()` re-fetches open orders from chain (guarded read) and re-syncs `manager` state via `manager.syncFromOpenOrders()`, then `_refreshStartupUpdatePlans()` rebuilds plans against the fresh chain state
- If retries are exhausted or batch helpers are unavailable → `_executeStartupSequentialUpdateFallback()` one-by-one with per-failure recovery

**Creates:** `_executePlannedStartupCreates` groups the outermost grid slots toward the center (BUY descending / SELL ascending), so the most price-critical orders are placed first. BitShares DEX batch-create operations are used where supported. Every created chain ID is captured into `phase2CreatedOrderIds` so Phase 3 cannot later cancel the freshly-created orders.

### Phase 3 — Fresh Re-read, Adoption, Stale Surplus Cleanup

**Source:** Phase 3 in `reconcileGridOrders()` (guarded by `if (!dryRun)`).

1. **Guarded fresh re-read:** `readOpenOrdersGuarded` re-fetches all open orders. A truncated result returns `null` and Phase 3 defers, keeping the pre-Phase-2 counts for the summary log; a capped window omits exactly the freshest Phase-2 creates.

2. **Adopt uncertain-landed creates:** For any fresh chain order not matching a grid `orderId` and not created by a slot, it attempts targeted slot adoption — matching a VIRTUAL slot by type+price+size (within tolerance) and registering it via `_applySync(..., 'createOrder')` with the create-fee deduction. Full `syncFromOpenOrders` is deliberately **not** used here (its pass-1 virtualizes ACTIVE slots missing from the snapshot, and a lagging read right after the Phase-2 broadcast would destroy the confirmed grid). If adoption fails, the ID is still protected from surplus-cancel; the next sync loop's orphan adoption registers it.

3. **Stale surplus cancellation:** Per side, count orders exceeding `targetCount` that no grid slot holds via `orderId` (including the Phase-2 created IDs). Cancel only these untracked surplus orders, sorted by chain ID for determinism. This catches orphans lost during grid reinitialization — on-chain orders with no corresponding grid slot.

### Partial Failure State

If Phase 2 partially succeeds (some cancels, some creates fail), there is no rollback. The bot proceeds with the resulting state. Because the reconcile runs at startup before the fill pipeline activates, no fills are missed during this window. Remaining mismatches are caught by the next maintenance/structural divergence cycle or the next startup reconcile.

### Timeouts and Read Coverage

- **No per-attempt race** around the reconcile itself — the 1.4.8 change removed it to avoid orphaning mid-batch broadcasts (see the [`recalculateGrid`](../modules/order/grid.ts) call site in `modules/order/grid.ts`).
- The whole resync is bounded by a **10-minute total timeout** (`PIPELINE_TIMING.TIMEOUT_MS * 2`) and applied with `Promise.race` in `recalculateGrid()`.
- Every internal chain read goes through `readOpenOrdersGuarded` with the 30s / 3-retry / node-failover standard. Truncated reads are always ambiguous and return `null`; empty reads are ambiguous only when a caller explicitly sets `deferEmpty: true`. Phase-2 cancellation uses the default empty-aware policy, then validates each plan against the fresh per-order signature before any mutation.

---

## Edge Cases (All Hit in Production or Code Review)

### Fresh Grid Guard (`matchedOnGrid > 0`)

**`_reconcileStartupSide()` in `grid_reconcile_internal.ts`**

When a brand-new grid is generated, every slot is VIRTUAL — `matchedOnGrid = 0`. Without a guard, every on-chain order appears "unmatched" and would be cancelled as excess:

```typescript
if (matchedOnGrid > 0 || neededSlots === 0) {
    cancelCount = Math.max(0, chainCount - targetCount);
}
```

When `matchedOnGrid === 0` AND scaling up (`neededSlots > 0`), excess cancellation is skipped — the guard covers both the fresh-grid scenario and the scale-down case (`neededSlots === 0`). Stale duplicates are still caught by the SUSPECTED DUPLICATE detection in Phase 1 of `reconcileGridOrders`.

### Grid-Edge Lock

**`_isGridEdgeFullyActive()` in `grid_reconcile_internal.ts`** detects when the grid boundary is fully active (all slots on-chain) before cancelling excess orders.

When all outermost orders of a side are ACTIVE with `orderId`, all balance is committed to the edges. Cancel the **largest** order among the update candidates (`_cancelLargestOrder()`) to free maximum funds with minimum operations, since the DEX does not expose partial-reduce in one operation. The cancelled slot gets a replacement create.

Detection sorts orders by price (BUY descending, SELL ascending) and checks that the outermost ones are all `isOrderPlaced()`.

### Duplicate Cancellation

**`reconcileGridOrders()` in `grid_reconcile.ts`**

An unmatched chain order whose price equals an active same-type grid slot's price — exact slot-price equality via `priceSlotEqual` at the asset precision — is a **suspected duplicate** → queued for Phase 2 cancellation (not cancelled under lock). Non-equal neighbours are only logged with nearest-same-side diagnostics, never cancelled here. The earlier fuzzy `SUSPECTED_DUPLICATE_TOLERANCE_MULTIPLIER` (5× `calculatePriceTolerance`) was removed.

### Batch Update Failure Recovery

Up to 3 batch attempts (`maxBatchAttempts = 3`). Each failure triggers a recovery sync + plan refresh. If all plans are empty → resolved early. After 3× → sequential fallback with per-plan recovery (each individual failure triggers a recovery sync + queue refresh).

### Phantom Orders via Reconcile

Reconcile's role in the defense-in-depth: during Phase 1, any ACTIVE/PARTIAL order whose `orderId` is not found on-chain is reset to VIRTUAL with `skipAccounting`. The freshly-assigned deferral protects in-flight broadcasts, and the ghost heuristic lets known fills pass. See [`developer_guide.md`](developer_guide.md#phantom-orders-prevention-defense-in-depth) for the full 3-layer defense.

### Shelf Orders (Fork-Kept Manual Orders)

Live on-chain orders with non-slot-N ids below the rail (e.g. `deep-*` manuals kept across a fork) are **shelf orders**: they sit outside the grid contract and must survive every startup path untouched. Three gates enforce this (all no-ops on grids that only mint slot-N ids):

- **Reserve classification/placement** (`order.ts`, `grid_reconcile_internal.ts`, `manager.ts`): `edgeOrderIdSet`, the Tier-2 live-anchor scan, `_pickEdgeSlots`, and `pickEdgeSlots` all gate to `parseSlotIndex(id) !== null`, so a shelf can never count as the edge (which would mask a real edge deficit) nor be activated as an edge order it would never be counted as. The live-edge count additionally excludes window members via `liveWindowIdSet`, so an edge-reaching window cannot masquerade as dedicated edge orders.
- **Startup excess cancels** (`grid_reconcile_internal.ts`): the matched-excess selection filters to slot-N ids in both planOnly and execute branches — the cheapest-first sort would otherwise wipe the shelf on the next boot.
- **Geometric size recalc** (`grid.ts`): `_recalculateGridOrderSizesFromBlockchain` skips non-slot-N slots in the per-slot loop, so divergence-triggered resizing never overwrites manual shelf sizes on-chain (the shelf stays in the budget denominator, so allocation math is unchanged).

### COW Interaction

Reconcile Phase 1 runs under `_gridLock` with no side effects on the frozen master Map. The working grid is not involved — reconcile is a startup operation that runs before the COW pipeline is active. See [`COPY_ON_WRITE_MASTER_PLAN.md`](COPY_ON_WRITE_MASTER_PLAN.md#safety-guardrails) and [`COW_INVARIANTS.md`](COW_INVARIANTS.md#reconcile) for COW rules.

### Slot-Price Invariant at the Reconcile Emission Sites

Three of the six guarded emission sites are reconcile sites (`RECONCILE-CREATE`, `RECONCILE-UPDATE`, `STARTUP-CREATE` in `grid_reconcile_internal.ts`): every op reconcile emits is checked against the slot's genesis level and an off-grid emission is skipped, not broadcast — see [`GRID_PRICE_INVARIANT.md`](GRID_PRICE_INVARIANT.md). The coupling is bidirectional: the invariant guard's persistent-rejection escalation and the deferred-hold escalation both exit through the same structural resync (debounced reload → full reset) described here, and a full reset's update-first reconcile emits the rail's genesis level, so the guard does not block its own resolution.

### Fill Discipline (unsettled fills + last-fill placement)

Reconcile derives its window from the **master grid**, which is only as fresh as the last applied fill. Two gates keep a top-up from being derived from geometry that has not absorbed the latest trades (both added after the 2026-11-02 buy-higher incident: 9 buy-lower violations, 23.5% of the window's BTS):

- **Unsettled-fill gate** (`hasUnsettledFills`, `utils/system.ts`): while fills are queued (`_incomingFillQueue`), draining (`_deferredFillsPending`), in flight (`_fillBatchInFlight`) or owed a crawl (`_pendingFillCrawls`), `maybeRunTargetedDriftReconciliation` defers the targeted reconcile entirely and `_reconcileStartupSide` defers only the **window top-up** creates (1:1 repairs — cancelled-slot replacement, vacated-rail refill — still run). The master still counts filled slots as ACTIVE in that window, so a top-up would restore the expensive end of the rail.
- **Last-fill placement guard** (`isLastFillPlacementBlocked`, `utils/system.ts`): every reconcile placement (create in `_createOrderFromGrid` and the batch create path, plus the re-pricing relocation in `_prepareStartupUpdatePlan`) is refused when it sits on the wrong side of the last fill **or on the same grid level** (within half an increment — a slot level and its execution price differ by rounding). A same-price relocation is an adoption, not a placement, and is exempt. `_pickVirtualSlotsToActivate` applies the same predicate so the pick budget rolls to the next level down/up instead of being spent on a level the create would refuse — the filled level is never re-stamped same-side (the "rotate to bottom BUY / counter SELL" behaviour).

A fill whose order id no longer sits on an ACTIVE/PARTIAL slot is no longer dropped: `attributeUnmatchedFillToGrid` (shared by `SyncEngine._absorbUnmatchedFill` and the orphan-credit sweep in `dexbot_fill_runtime.ts`) records the **pivot + owed crawl from the real execution price**. It resolves the slot two ways — the chain id when a virtualised slot still owns it, otherwise the **genesis ladder level of the execution price** (the common case, because `virtualizeOrder` NULLS `orderId`; this is what the incident actually hit). A crawl is only owed by a HOLE, and a price outside the frozen rail is refused so a shelf order cannot arm the pivot. Without this the pivot stays on a stale, higher fill and the direction rule then permits re-buys above the market.

**The dark level it leaves behind is repaired too.** A slot virtualised while its order stayed live on chain reads as *not active* (`_countActiveOnGrid` needs ACTIVE/PARTIAL) while its order still counts in `chainCount`, so the side reports a shortfall it can never repair — and the planner sees a free level that already holds an order. Three pieces close that:

- `reviveVirtualSlotFromChain` re-materialises the slot **in place** (master-only, no broadcast) when the chain order is still live *and* rests at that slot's level. Wired into sync pass 1 (`sync-pass1-revive`) and reconcile Phase 1 (`startup-revive`). A rotation alias (chain order at another level) is never resurrected.
- Sync pass 1 also clears a **stale** id on a non-placed slot (`sync-clear-stale-id`) without booking a fill, so the level becomes a normal hole again.
- `validateCreateTargetSlots` treats *any* slot that still owns an `orderId` (any state) as `slot_occupied` (hard: the batch aborts), and a slot with a possibly-landed CREATE as the softer `slot_create_uncertain` (only that CREATE is withheld — an unknown outcome is not proof of a live order). `reconcileGrid` no longer treats a virtualised slot that owns an id as a hole. Together with the stale-id cleanup this blocks a **duplicate CREATE at a price that already holds an order** without stranding a level whose id was merely stale.

The spread-correction planner judges candidates with the same predicate as the placement guards (direction **plus same grid level**), so it no longer plans a create the broadcast guard will refuse; an unplaceable side reports the `last-fill-blocked` stall instead of burning a cycle.

### Truncated-Read Ambiguity (since 1.4.8)

Every chain read feeding an absence/surplus decision goes through `readOpenOrdersGuarded`. A truncated snapshot is always unreadable. An empty snapshot is also unreadable at callers that set `deferEmpty: true`; the Phase-2 cancellation pre-read intentionally accepts a complete empty result, executes no plan, and leaves all remaining state for the normal reconcile paths:

- `_recoverSyncFromChain()` — plus its recovery sites in `_createOrderFromGrid` / `_cancelChainOrder` — defers on empty/truncated reads (`deferEmpty: true`). A pass-1 phantom cleanup would otherwise virtualize live slots from a partial window.
- `_adoptPossiblyLandedCreate()` defers to an uncertain outcome on truncated reads, and the startup group batch uncertain verification follows the same rule.
- Phase 3 final refresh skips adoption/surplus-cancel on a truncated read, keeping the pre-phase-2 counts for the summary log.
- Adoption paths (`_adoptPossiblyLandedCreate`, grouping path, reconcile adoption loop) apply the create-fee deduction via `_applySync` for accounting parity.

The underlying rule is `INV-BROADCAST-004`: a capped `get_full_accounts` window omits the freshest orders (fresh creates sort last), so absence can never be authoritative on a truncated read.

---

## Lock Hierarchy

**`manager.ts` lock declaration** — canonical reference in [`developer_guide.md`](developer_guide.md#lock-ordering-for-deadlock-prevention).

```
Level 0: _fillProcessingLock    Level 1: _divergenceLock
Level 2: _syncLock              Level 3: _gridLock
Level 4: _fundLock
```

Acquire in ascending level order only. AsyncLock is re-entrant (nested `acquire()` run directly, not queued).

### Historical Correction (1.4.6)

Before 1.4.6, `_syncLock` was Level 3 and `_gridLock` was Level 2, causing ABBA deadlock when reconcile needed `_gridLock` (old Level 2) while holding `_syncLock` (old Level 3). The workaround flag `gridLockAlreadyHeld` patched 8 call sites.

Commit `705cde9c` fixed it: swapped levels (`_syncLock → 2`, `_gridLock → 3`), eliminated the flag, and restructured Phase 1 to be purely in-memory so no RPC calls run under `_gridLock` ([`developer_guide.md` §Startup Sequence](developer_guide.md#startup-sequence--lock-ordering)).

### Nesting Safety (1.4.6)

Commit `e64db685` replaced 6 single-value boolean state fields with refcounts/stacks to prevent premature resume from re-entrant nested acquisitions.

---

## Key Constants

| Constant | Value | File | Role |
|----------|-------|------|------|
| `maxBatchAttempts` | `3` | `grid_reconcile.ts` | Update-batch retry limit |
| `PRICE_TOLERANCE_MAX_PERCENT` | `0.01` (1%) | `constants.ts::GRID_LIMITS` | Cap on price tolerance |
| `PRICE_TOLERANCE_MIN_ABSOLUTE` | `0.0001` | `constants.ts::GRID_LIMITS` | Floor for price tolerance |
| `PIPELINE_TIMING.TIMEOUT_MS` | `300000` (5min) | `constants.ts::PIPELINE_TIMING` | Base pipeline timing; resync uses 2× (10 min) |

---

## Testing Coverage

| Test File | Coverage |
|-----------|----------|
| `tests/test_grid_reconcile.ts` | 8: grid detection, largest-order cancel, ordering |
| `tests/test_grid_reconcile_regressions.ts` | 16 startup scenarios: fund/fund-lock behavior, verified-after-failure, slot/skip cases, `matchedOnGrid`, Phase-3 surplus, phantom deferral, duplicate ownership and settlement, persistent-duplicate escalation, changed-plan rejection, per-plan independence, and truncated/failed pre-cancel reads |
| `tests/test_resync_duplicate_race.ts` | Phase 3 duplicate race |
| `tests/test_resync_balance_fix.ts` | Fund reuse during Phase 3 |
| `tests/test_resync_invariants.ts` | Fund invariant suppression during transient resync |
| `tests/test_uncertain_broadcast.ts` | Startup uncertain-create adoption + truncated-read deferral (UNC-013e–g, 1.4.8) |
| `tests/test_race_condition_fixes_batch1.ts` | ABBA deadlock (RC-1B) |
| `tests/test_async_lock_force_release.ts` | Nested multi-lock re-entrancy |
| `tests/test_targeted_drift_reconcile.ts` | Active-order shortfall triggers sync |
| `tests/test_edge_orders.ts` | Reserve startup coverage: fully-placed matched-surplus cancels, orphan+matched ordering, at-target silence, plan/execute parity, shelf-order survival, reserve-deficit trigger (`buy reserves 0/2`) with filled/disabled/empty-budget silence, window-exclusion counting |
| `tests/test_grid_fill_discipline.ts` | Placement predicate (direction + same grid level), picker fall-through on both sides, create refusal before broadcast, window top-up deferral while fills are unsettled, slot revive (ACTIVE/PARTIAL + all refusals), CREATE occupancy gate, dark-level hole gate, spread planner/guard parity, orphan-sweep attribution |
| `tests/test_fill_attribution_virtual_slot.ts` | Fill absorbed into a virtualised slot: pivot + owed crawl from the execution price (chain-id **and** ladder identity), unknown-order/no-stacking/dryRun cases, occupied-level and out-of-grid refusals, incident ladder refusals, `hasUnsettledFills` states |
| `tests/repro_phantom_orders.ts` | Phantom order prevention |

---

## File Reference

| File | Role |
|------|------|
| `modules/order/grid_reconcile.ts` | Public API + 3-phase orchestrator, including per-plan Phase-2 cancellation validation |
| `modules/order/grid_reconcile_internal.ts` | Internal helpers — `_reconcileStartupSide`, grid detection, recovery, uncertainty |
| `modules/order/manager.ts` | Lock hierarchy definition, `_applyOrderUpdate`, phantom guard, `reconcileGrid` entry, COW integration |
| `modules/order/async_lock.ts` | AsyncLock engine with ALS re-entrancy |
| `modules/order/sync_engine.ts` | Blockchain sync pipeline |
| `modules/order/grid.ts` | Grid creation, `recalculateGrid` (full resync) calls reconcile |
| `modules/chain_orders.ts` | `readOpenOrdersGuarded` / guarded read infrastructure |
| `modules/constants.ts` | Timing, tolerance, retry constants |

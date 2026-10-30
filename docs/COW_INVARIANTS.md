# System Invariants (Stable Theory Contract)

This document defines the non-negotiable behavioral invariants for the DEXBot2 system. It is a contract for code review and release safety, not a design tutorial.

## Scope

- **COW Pipeline**: planning, projection, reconciliation, commit, and fund accounting flows.
- **Sync Engine**: fill history sync, open-order sync, orphan detection, cache vs chain consistency.
- **Maintenance Runtime**: pipeline gating, illegal-state handling, cooldown semantics, dust ordering.
- **Grid & Reconcile**: price-level uniqueness, dust detection scope, reconcile cancel semantics.
- **Batch & Pipeline**: stale handling, retry gating, stale-flag cleanup.
- **Fund Registry**: cross-bot allocation invariants.
- **Subscriptions**: health watchdog, silent-death detection.
- **Broadcast**: uncertain-broadcast recovery, retry, deadlock-free reconcile.

## Invariant Prefixes

| Prefix | Subsystem |
|--------|-----------|
| `INV-COW` | COW pipeline |
| `INV-PROJ` | Projection |
| `INV-ID` | Order identity |
| `INV-ACC` | Accounting / fund tracking |
| `INV-SYNC` | Sync engine |
| `INV-MAINT` | Maintenance runtime |
| `INV-GRID` | Grid structure |
| `INV-RECON` | Reconcile |
| `INV-BATCH` | Batch / pipeline |
| `INV-STATE` | State / lifecycle |
| `INV-REG` | Fund registry |
| `INV-SUB` | Subscriptions |
| `INV-BROADCAST` | Broadcast |

---

## COW Pipeline

- `INV-COW-001` Master immutability until commit
  - The master grid must not be mutated during planning/execution prep.
  - All intermediate mutations happen in `WorkingGrid`.
  - Master updates occur only during commit after guard checks pass.

- `INV-COW-002` Commit atomicity
  - Commit swaps working state to master atomically.
  - On failed/aborted execution, working state is discarded and master remains unchanged.

- `INV-COW-003` Pre-broadcast staleness guard + bounded re-plan
  - A plan whose working grid went stale before broadcast (master mutated mid-planning: fills, syncs) must never be broadcast as-is.
  - Re-plan ONCE from fresh master with the same fills (`replanStaleBatch`, bounded by `STALE_PLAN_REPLAN_LIMIT` in `dexbot_cow_runtime.ts`); restore the boundary-shift budget consumed by the abandoned plan; clear only the abandoned batch's OWN pending-broadcast entries (earlier unresolved batches' entries are kept — the recursion guard then aborts + reconciles instead of re-creating possibly-landed slots).
  - Still stale or no fill context → proceed + structural resync (never a silent abort that drops the fill set); commit-time guard + chain adoption close residual divergence.

- `INV-COW-004` Working-grid stack exactly-once push/pop
  - Pushes go through the single `_pushWorkingGridRef` (sets `_workingGridPushed` marker); releases go through `_popWorkingGridRef` (marker-guarded, early-return sites) or `_releaseWorkingGridRef` (identity-checked, commit sites).
  - A result that was never pushed must never pop — that would underflow or steal a nested grid's stack entry. `_commitWorkingGrid` releases the entry exactly once on every settle path (return or throw).

- `INV-COW-005` Grid regeneration bumps `_gridVersion`
  - `_clearOrderCachesLogic` must bump `_gridVersion` so an in-flight COW plan (baseVersion from the pre-swap grid) is refused at commit instead of committing over a regenerated zero-slot grid.

- `INV-COW-006` Boundary moves only on fills and same-batch spread promotion
  - Fund changes never move the boundary. Only boundary crawl (`deriveTargetBoundary`, `order/utils/order.ts`) and spread promotion move it, and promotion shifts it only onto orders placed in the same atomic batch (`prepareSpreadCorrectionOrders`).
  - Funds drive order sizing/budget allocation only; `syncBoundaryToFunds`/`calculateFundDrivenBoundary` are deleted (1.5.3).

- `INV-COW-007` Boundary hold on guard-skipped refills
  - When a slot on the plan's refill wire (`collectRefillSlotIds`: the plan's CREATE ids minus edge-ladder edge ids) was guard-skipped at broadcast (`skippedUpdateSlotIds` ∪ `clampedUpdateSlotIds` ∪ `skippedCreateSlotIds`), `resolveRefillBoundaryHold` keeps the COMMITTED boundary instead of committing the plan's shifted one over the stranded rail hole; the grid still commits.
  - Edge-ladder CREATEs are excluded because reserves are static edge insurance whose fills never crawl — a skipped reserve must not pin geometry.
  - The hold rides to the commit as `options.boundaryHeld`, which suppresses the pending-crawl clear.
  - `trackBoundaryHold` counts consecutive hold batches (`manager._consecutiveBoundaryHolds`, cleared on the first clean batch) with a last-hold snapshot (`manager._lastBoundaryHoldInfo`); runs of 3+ escalate visibly. It also records a hold signature (`manager._lastHeldPlanSignature`: committed boundary + guard pivot + `_lastFilledAt` + held wire) so a fill-less re-plan of an unchanged state defers instead of re-broadcasting the identical vetoed plan.
  - Fill-driven rebalances never sleep on `_broadcastingFlag` inside `_fillProcessingLock`: `performSafeRebalance({deferIfBroadcasting:true})` returns a `deferred` result and the region-end hook schedules one no-fill rebalance (`schedulePostRecoveryRebalance`). This prevents the 20s lock-acquisition-timeout cascade when a broadcast region outlives the 30s `_awaitBroadcastIdle` wait. The stale-flag watchdog (`_clearStaleBroadcastFlag`, 120s) fires the same region-end hook when it hard-clears a leaked flag, so deferred fills are woken even when the region never ends through `stopBroadcasting()`.
  - A hold run carrying fresh fills (>= `TIMING.BOUNDARY_HOLD_RESYNC_THRESHOLD`) requests a guard-aware structural re-center (`requestStructuralGridResync`, cooldown `TIMING.BOUNDARY_HOLD_RESYNC_COOLDOWN_MS`) instead of holding forever — the heal path when the grid is trailing the market.

- `INV-COW-008` Owed fill crawls survive unapplied commits
  - `order/strategy.ts` records a crawl per shift-eligible fill at intake (slot-level dedupe, capped at 500); `deriveTargetBoundary` folds still-owed `_pendingFillCrawls` into the next derivation, excluding the current batch's slots, edge slots, and window members — a window that reaches the grid edge is not an edge order, using the same window exclusion every placement picker and `countLiveEdgeOrders` apply.
  - `_commitWorkingGrid` clears them only when the plan's boundary was actually applied — a held boundary (`boundaryHeld`), a gate-rejected boundary, and a null boundary all leave them owed.
  - A window that lands BEHIND the newest real fill is repaired by `reanchorBoundaryFromLastFill` (called from `calculateTargetGrid` right after the derivation): the fill anchors the geometry — `SELL fill at f => boundary ≥ f − gapSlots`, `BUY fill at f => boundary ≤ f − 1` — because a ±1 crawl can never catch up. Fail-closed preconditions: a pivot whose `lastFillPivotSource` is `fill` (a book seed never anchors; the bot-scoped last-market-fill row is the fallback), on-ladder price within one increment, a post-clamp target that actually puts the fill outside the window, and `validatePersistedBoundary` (a strand refuses the re-anchor). The fill's OWN PARTIAL residual at the anchor slot is explicitly allow-listed (it is inside the band by construction), so a partial fill no longer deadlocks the repair. Startup/recovery load paths tolerate that pure in-band state (`tolerateTransientStranding`) so a restart does not rebuild the boundary before GAP-EVAC clears the residual. A successful re-anchor is absolute: it consumes the whole pending-crawl snapshot taken at plan time, so no older delta can be applied on top.
  - Consumption is SCOPED to what the derivation applied: `deriveTargetBoundary` returns `consumedCrawlIds` (the owed records whose shift it folded, plus the records it deliberately never counts — current-batch slots, edge-classified slots, malformed records), the plan carries it (`buildSuccessResult` → `CowResult` → `_commitWorkingGrid` options), and `_consumePendingFillCrawls` drops exactly those, logging `Dropped N … kept=M`. A capped fold consumes only the entries it actually applied (same-side prefix up to the applied magnitude), so the remainder stays owed exactly once. `_clearPendingFillCrawls` remains the explicit allowed-loss path (rebuild, rejected snapshot, restart replay) and drops everything.
  - A commit **without** the wire consumes nothing (a create-only plan never derived a boundary): clearing it would be the old silent-loss bug (2026-10-25: 7 slots 147–153 swept, every record dropped, boundary ending 7 levels behind).
  - `consumePendingFillCrawls` applies them onto a restored finite boundary; `applyPersistedPendingCrawls` is the shared startup/recovery wrapper used before sync/reconcile; `_clearPendingFillCrawls` drops them when the boundary is re-anchored (grid rebuild via `initializeGrid`, rejected snapshot via `rejectCorruptedGridSnapshot`, persisted snapshot wipe via `AccountOrders.clearGrid`).

- `INV-COW-009` LAST-FILL-GUARD pivot survives restarts with the snapshot, and only as a fill fact
  - Single source of truth: the manager's in-memory pivot is authoritative at runtime; the disk row is a mirror that rides the grid snapshot (`persistGridSnapshot` → `storeMasterGrid` 10th param → `lastFillPivot`), so it invalidates in lockstep with the boundary/genesis instead of forming a second ledger (the `_pendingFillCrawls` lockstep contract).
  - Provenance gate: only a pivot written through the shared `setLastFillPivot(type, price, 'fill')` writer is persist-eligible. A book-seeded pivot (`seedLastFilledPricesFromBook`, provenance `'book'`) is a heuristic — max resting buy / min resting sell is not market truth — and is never fossilized into the snapshot. The fill-batch and queued-fill refresh sites funnel through one implementation (free function in `utils/system.ts`; `OrderManager._setLastFillPivot` delegates to it), so value, timestamp, and provenance cannot drift apart; the queued-fill refresh and the restore path call the same free function directly, with the legacy-stub fallback built into the shared writer rather than copy-pasted. A single-sided book arms through the same writer with provenance `'book'`; the two-sided midpoint and per-side mirror seeds stay direct writes by design, because they carry no pivot provenance and must not be persist-eligible.
  - The row carries `{price, type, fillsAt, genesisHash}` validated by one shared gate (`normalizeLastFillPivot`) used by BOTH the `storeMasterGrid` sanitizer and the loader — the two shape checks cannot drift. `null` from the payload builder always clears the stored row (consumed pivot / cold manager / no live genesis), `undefined` stays a legacy no-op for old callers, and a malformed shape also clears.
  - Restore ordering: `grid.loadGrid` restores the pivot right after `_restoreBoundary` — with the persisted genesis applied and the grid re-typed, BEFORE the first reconcile/broadcast — so a restart cannot re-open the cold window where evacuation stamps get applied against a boundary still being rebuilt. All `loadGrid` callers (startup resume, price-match resume, recovery reload) inherit it; there is no second restore call site to drift.
  - Validation chain (`restoreLastFillPivot`): TTL expiry (`GRID_LIMITS.LAST_FILL_PIVOT_TTL_MS`, 24h; the pivot is a "latest fill" fact, not a permanent ratchet; expired pivots hand over to the startup book seed) and genesis binding (mismatched hash = dead generation) erase the row through one shared drop path (`clearPersistedLastFillPivot` under the bot's persistence lock, best-effort). Off-grid refusal (`resolveOnGridPivot` — the runtime's own ladder validator, imported lazily from the restore site so ONE implementation serves both the per-probe live guard and the restore; the restorer can never accept a value the runtime would refuse per probe) is a no-op that falls back to the book seed and leaves the row for the next snapshot flush to clear (the cold in-memory pivot makes the payload builder return null). The snapped ladder level is restored, never the raw float, and the ORIGINAL `fillsAt` is preserved through `setLastFillPivot`'s `atMs` param so the TTL keeps meaning "age of the last fill", not "time since this restart".
  - Generation invalidation mirrors the pending-crawl ledger: `initializeGrid` and `rejectCorruptedGridSnapshot` clear the in-memory pivot via `resetLastFillPivot` (exposed as `OrderManager._resetLastFillPivot`), which clears the FULL scalar family — per-side mirrors included — so `seedLastFilledPricesFromBook`'s cold gate cannot be silently suppressed by stale per-side values after a grid rebuild, and `AccountOrders.clearGrid` wipes the persisted row with the snapshot. The guard re-arms on the first real fill of the new generation.

- `INV-COW-010` Grid-layer spread-correction cycle is atomic and bounded
  - `checkSpreadCondition` holds the refcounted broadcast region (`startBroadcasting` / `stopBroadcasting`, released in `finally`) across its whole attempt loop, so a fill-driven rebalance defers rather than committing a master-version bump between the initial plan and its broadcast. This narrows the race; the COW commit guard remains the backstop.
  - Before broadcasting, `resolveOccupiedCorrection` re-derives a plan whose CREATE destination became a live order since planning (`getOccupiedCorrectionSlots`), or withholds it — a known-taken slot is never shipped. The COW build layer stays authoritative against a detector false positive.
  - A transient refusal re-plans ONCE from fresh master (`replanSpreadCorrectionFromFreshMaster`, bounded by `TIMING.SPREAD_CORRECTION_MAX_ATTEMPTS`); a non-transient refusal (`commit-refused` / `update-target-missing` / `unmatched-chain-orders` / `shutdown`) is not retried and counts toward the out-of-spread stale clock.
  - Candidates are tightening-edge-only on real grid slots (`tightensSpread` + distance-to-edge ordering + `doesNotCrossMarket`) AND last-fill consistent: the planner applies the guard's own direction rule (`passesLastFill`, same pivot, same predicate) before the quota slice, so a batch is never built from ops the broadcast guard would drop. An unplaceable side reports the geometry bind `last-fill-blocked` instead of a wasted "prepared but not executed" cycle.
  - The budget spent by the loop is chain-truth for a known candidate set: `available = chainFree − virtualReservation` is circular when the reservation describes the very slots being funded, so an over-sized projection (rail sized from a larger balance or from inventory locked in resting orders) would read 0 forever (`planned 3, placing 0`, 84 minutes live). `deriveChainTruthFundBudget` re-derives it as `min(chainFree, min(virtualReservation, Σ candidate ideals))` when `available` is 0 **and** the reservation exceeds chain free (a zero caused by fees or an empty balance is a real constraint and is honoured); the chain stays the final arbiter.
  - Terminal stalls are named and escalated on their own windows rather than the structural 30 minutes: rail oversubscription (`availableFund = chainFree − virtual` reads 0 while the side still holds inventory) on `SPREAD_STALE_FUND_ESCALATE_MS`, the `last-fill-blocked` geometry bind on `SPREAD_STALE_GEOMETRY_ESCALATE_MS`, and the persistence clock clears only after sustained tolerance (`SPREAD_STALE_IN_TOLERANCE_RESET_MS`) or a placement.
  - This is the grid layer's counterpart to `INV-COW-003` (COW-layer pre-broadcast re-plan) and to `INV-COW-007`'s broadcast-flag deferral contract.

- `INV-PROJ-001` New projected orders remain virtual
  - Orders projected into empty slots must be `VIRTUAL` with no `orderId` until chain confirmation.

- `INV-PROJ-002` Preserve on-chain PARTIAL size in projection
  - If identity is retained (`keepOrderId=true`) and current state is `PARTIAL`, projected size must preserve current on-chain remaining size.
  - It must not be overwritten by ideal geometric `targetSize`.
  - Exception: a `PARTIAL` with a rotation/size-update action targeting its `orderId` does use `targetSize` (the explicit-UPDATE path at `modules/order/utils/validate.ts:1187`).
  - Preserve-path size must be normalized to finite, non-negative value.

- `INV-PROJ-003` ACTIVE on-chain projection preserves current size (same as PARTIAL)
  - If identity is retained and state is `ACTIVE`, projection preserves current on-chain size via the same `shouldPreserveSize` path as `PARTIAL` (`validate.ts:1187`).
  - An explicit UPDATE action targeting the `orderId` is required to apply `targetSize`.

- `INV-ID-001` Order identity retention rule
  - `orderId` and on-chain state are retained only when order is on-chain and side/type is unchanged.
  - Otherwise projected order becomes `VIRTUAL` with `orderId=null`.

- `INV-ACC-001` Committed accounting source of truth
  - Committed chain/grid totals derive only from on-chain orders (`ACTIVE`/`PARTIAL` with `orderId`) and their projected sizes.
  - Virtual orders contribute only to virtual pools, not committed chain totals.

- `INV-ACC-002` Fund invariant consistency (INVARIANT 1)
  - Tracked totals must remain consistent with blockchain totals within `FUND_INVARIANT_PERCENT_TOLERANCE`.
  - `Total = Free + Committed` must hold per side.
  - False violations due to ideal-size projection overstatement are prohibited.

- `INV-ACC-003` Cross-bot fund registry invariant (INVARIANT 3)
  - Shared-account per-bot commitment must not exceed the bot's proportional share of chain balance.
  - Checked with widened tolerance `max(PERCENT_TOLERANCE * 3, 0.15)`.
  - Registry failure logs an error (`order/accounting.ts:636-685`), not a silent skip.

---

## Sync Engine

- `INV-SYNC-001` Drift-refetch for partial fill correctness
  - `isEffectivelyFull` must not unconditionally trust cached `rawOnChain.for_sale`.
  - When cached `for_sale` is smaller than the grid's own size (drift signal), refetch from chain via `readSingleOrder`.
  - `isEffectivelyFull` requires either: chain-confirmed empty (refetch returned null), grid also at 0, or the other side rounding to 0.
  - The legacy `newSizeInt <= 0` fast-path is forbidden.

- `INV-SYNC-002` No TTL-based chain refetch
  - Chain is only consulted on a drift signal (cache < grid size).
  - Time-based TTL refetches are prohibited — a stale-but-consistent cache is still correct.

- `INV-SYNC-003` Drift refetch null = chain-confirmed empty
  - When drift refetch returns null from `readSingleOrder`, the order is authoritatively gone.
  - The sync engine must treat this as a chain-confirmed empty, not a connection failure.

- `INV-SYNC-004` Orphan adoption rejects duplicate price levels
  - Pass-2 fallback adoption must check whether an active grid order of the same type already exists at the same price (within `calculatePriceTolerance` using `Math.max(size)`).
  - If a duplicate exists, the orphan is NOT adopted; it is pushed to `unmatchedChainOrders` for chain cancel.
  - Size is irrelevant — any duplicate violates the one-order-per-price-level invariant.

- `INV-SYNC-005` Fill queue back-pressure
  - Subscription callbacks must not push fills beyond `MAX_INCOMING_FILL_QUEUE`.
  - Rejected fills must leave subscription cursors retryable; the queue must remain unchanged.
  - Back-pressure must not start a consumer for rejected fills.

- `INV-SYNC-006` syncFromOpenOrders acquires fill-processing lock
  - `syncFromOpenOrders` acquires `_fillProcessingLock` by default.
  - `AsyncLock` is re-entrant — callers already inside the lock rely on the intrinsic `isReentrant()` check instead of a `fillLockAlreadyHeld` parameter.
  - Direct call sites without the lock contract are prohibited.

- `INV-SYNC-007` Authoritative sync preserves fetched free balances
  - Free-balance values fetched during a sync must not be silently discarded; they seed the optimistic balance model.
  - If fetched balances are unavailable (failure/error), the optimistic model remains untouched rather than zeroed.
  - `synchronizeWithChain` must not double-deduct already-locked funds from fetched `buyFree`/`sellFree`.
  - After authoritative open-order sync, `checkFundDriftAfterFills` is expected to return `isValid=true` as a design consequence (no enforcement code exists — this sub-clause expresses the intended post-condition, not an assertion).

- `INV-SYNC-008` SPREAD-typed fills resolve the real side
  - A SPREAD slot can carry an on-chain order (spread-correction activation). Fill processing must resolve the real BUY/SELL side (chain order type, pays asset, or price-vs-startPrice convention) before pushing the fill or computing the transition.
  - A SPREAD-typed fill would silently drop the `deriveTargetBoundary` shift and produce an illegal SPREAD+on-chain state rejected by `validateOrder`.

---

## Maintenance Runtime

- `INV-MAINT-001` Pipeline in-flight defers maintenance
  - When `isPipelineEmpty` returns `isEmpty=false` (batch in-flight, recovery-in-flight, or broadcasting active), `checkSpreadCondition` and divergence corrections must be skipped.
  - Dust cancels broadcast directly to chain and are safe to call regardless of pipeline state.
  - Pipeline signals (`batchInFlight`, `recoveryInFlight`, `broadcasting`) must be passed to `isPipelineEmpty`.

- `INV-MAINT-002` Illegal state abort
  - When `consumeIllegalStateSignal` returns a non-null signal, the maintenance cycle must:
    - Trigger immediate recovery sync (`_triggerStateRecoverySync`).
    - Skip persistence (`_persistAndRecoverIfNeeded`) in the same cycle.
    - Skip remaining maintenance steps (spread checks).
    - Arm one maintenance cooldown cycle (`_maintenanceCooldownCycles = 1`).

- `INV-MAINT-003` Maintenance cooldown
  - After a hard-abort (illegal state), the next maintenance cycle must skip all checks (spread, health, etc.).
  - Cooldown is exactly one cycle; normal checks resume on the subsequent cycle.
  - Cooldown must not stack or compound.

- `INV-MAINT-004` Maintenance idle gate
  - Maintenance must wait for a quiet window with no fill queue, sync, or batch activity (`BLOCKCHAIN_SETTLE_DELAY_MS`).
  - Recent activity tracking covers: fill queueing, fill processing completion, COW batch start/end, open-order sync, periodic fetches.

- `INV-MAINT-005` Dust-first ordering
  - Dust partials are cancelled immediately on detection — no delay, no timer.
  - Grid resync and structural maintenance wait only for the idle settle delay.

---

## Grid Structure

- `INV-GRID-001` One-to-one order mapping
  - One grid slot = at most one on-chain order. No two chain orders may map to the same grid slot.
  - Sync engine tracks `matchedGridOrderIds` through both sync passes and skips already-matched slots.
  - Surplus orders (matched count above the per-side `coreOrders` + `edgeOrders` targets) are flagged for cancellation.

- `INV-GRID-002` One order per price level
  - The active grid must have at most one on-chain order per (type, price) pair.
  - Duplicate price levels are a structural violation — the sync engine must reject orphan adoption at a duplicate price, and the reconcile layer must cancel offenders on chain.
  - Size is irrelevant; any duplicate violates this invariant.

- `INV-GRID-003` Interior dust detection at duplicate price levels
  - Interior partials (not top-of-window) are eligible for dust detection if they share a price level with an ACTIVE sibling.
  - Top-of-window partials remain always eligible.
  - Two PARTIALs sharing a price with no active sibling do not qualify (left to rebalancer).

- `INV-GRID-004` Slot price equals its genesis level ([GRID_PRICE_INVARIANT.md](GRID_PRICE_INVARIANT.md))
  - `order.price` for a slot-`idx` order must equal `priceForSlot(idx, genesis)`; the genesis ladder is the only authoritative price for a slot.
  - Enforced at all six emission sites (CREATE / UPDATE / CREATE-FALLBACK, RECONCILE-CREATE / RECONCILE-UPDATE, STARTUP-CREATE): an off-grid emission is blocked, never broadcast.
  - Range guards (`isChainPriceOutOfGrid`) are bounds checks, not membership checks — they cannot substitute for this invariant.
  - Adoption keeps the slot's own level (a fill/chain price is metadata, not the slot's price); `loadGrid` repairs a pre-existing off-grid slot price at load.
  - A snapshot carrying orders but no usable ladder is **refused** before any mutation (`loadGrid`, before the startup resume decision, and at the persisted-row schema), and the sync entry refuses to reconcile a ladder-less grid at all — without a ladder no consumer has authority for a slot's price, which is what this invariant exists to prevent. The tolerance matcher that used to cover that state has been removed. `config.gridLimits.MISSING_GENESIS_POLICY` picks the response: `'rebuild'` (default, structural resync) or `'halt'` (manual reset). One decision, one module: `modules/order/genesis_policy.ts`.
  - Tests: GPI-001..015 (`tests/test_grid_price_invariant_guard.ts`), GPI-WIRE-001..009 (`tests/test_grid_price_invariant_wiring.ts`), LEGACY-ADOPT/MATERIALIZE/ADOPT-NAME (`tests/test_sync_out_of_grid_defer.ts`), GEN-01..21 (`tests/test_missing_genesis_policy.ts`).

---

<a id="reconcile"></a>
## Reconcile ([GRID_RECONCILE.md](GRID_RECONCILE.md))

- `INV-RECON-001` Rotation-only size updates in reconcile
  - `reconcileGrid` does not emit generic in-place size UPDATEs for active slot diffs.
  - Size-changing UPDATE actions are rotation updates (`newGridId` path).
  - Non-rotation size correction is handled by dedicated maintenance flows.

- `INV-RECON-002` Dust health gating parity
  - Dust health thresholding applies consistently to both CREATE and rotation destination holes.

- `INV-RECON-003` Reconcile cancels duplicate chain orders unconditionally
  - An unmatched chain order whose price equals an active same-type grid slot's price (exact slot-price equality via `priceSlotEqual` at the asset precision) is a suspected duplicate and must be cancelled on chain via `_cancelChainOrder` with `releaseUntrackedFunds: true`.
  - Cancelled IDs are filtered out of `unmatchedParsed` to prevent reprocessing.
  - No size guard — any duplicate at the same price is a violation.
  - The earlier fuzzy `SUSPECTED_DUPLICATE_TOLERANCE_MULTIPLIER` (5× `calculatePriceTolerance`) and `SUSPECTED_DUPLICATE_TOLERANCE_FLOOR` are removed; only exact price-level equality triggers a reconcile cancel.
  - Cancel deferral under `INV-RECON-006` applies before submission.

- `INV-RECON-004` Rebalance must not convert on-chain slots to SPREAD via CREATE
  - `performSafeRebalance` must not emit `CREATE` actions that convert existing on-chain slots into SPREAD orders.
  - On-chain mid-slot must keep its BUY/SELL type before commit.

- `INV-RECON-005` Extreme placement ordering
  - BUY placements must use nearest available free slots first (descending price, so the nearest-to-center slots fill first — `order/utils/order.ts` `buildOutsideInPairGroups`).
  - SELL placements must use nearest available free slots first (ascending price).

- `INV-RECON-006` Fresh-placement cancels are deferred for a grace window
  - A CANCEL action targeting an `orderId` placed within `TIMING.SURPLUS_CANCEL_GRACE_MS` (15 min) is deferred. The timestamp is written by `recordOrderPlacement` into `manager._placedAt` and tested by `isFreshlyPlacedOrder`.
  - `COWRebalanceEngine.execute` drops the whole slot's action group for a deferred cancel (dropping only the CANCEL would let a paired CREATE fold back into an UPDATE and re-materialize the placement), then re-syncs the deferred slots from master via `workingGrid.syncFromMaster` so the commit does not virtualize a still-live order.
  - Divergence correction (`applyGridDivergenceCorrections`) applies the same guard after dropping any queued committed-size UPDATE for the not-desired/size-0 slot.
  - `grid-load`/`grid-init` load contexts are excluded so restarts do not suppress the sweep.

---

## Batch / Pipeline

- `INV-BATCH-001` Illegal state batch abort
  - `executeBatch` throws `ILLEGAL_SPREAD_STATE` on an illegal grid layout (emitted at `modules/order/utils/validate.ts`, propagated via `modules/order/manager.ts` `_throwOnIllegalState`).
  - The `_handleBatchHardAbort` catch for `ILLEGAL_ORDER_STATE` (`dexbot_class.ts:533`) is a test-only dead branch — production never emits that code; only a test stub uses it.
  - In production, recovery + cooldown are armed on the next maintenance tick via `_abortFlowIfIllegalState` (the `INV-MAINT-002` path), returning `abortedForIllegalState: true` to the caller. The caller does not need to return immediately; the maintenance tick handles recovery.
  - Hard abort triggers one immediate recovery sync (`_triggerStateRecoverySync`) plus arms one maintenance cooldown cycle (`_maintenanceCooldownCycles = Math.max(current, 1)`).

- `INV-BATCH-002` Stale-only cancel fast path
  - When a cancel-only batch fails with "order does not exist" (stale), the handler must:
    - Virtualize the slot (`state = VIRTUAL`, `orderId = null`, `size = 0`, `rawOnChain = null`).
    - Return `stale: true`.
    - NOT trigger a recovery sync.
    - Track the stale order id in `_staleCleanedOrderIds` to prevent double-credit.
    - Preserve manager index validity.

- `INV-BATCH-003` "Cannot deduct" → recovery sync
  - When `executeBatch` throws "Cannot deduct all or more from order than order contains", the handler must:
    - Return `recoveredBySync: true`, `reason: 'ORDER_SIZE_DRIFT'`.
    - Trigger one recovery sync.
    - NOT virtualize the slot.
    - Preserve `orderId` until sync reconciles it.
    - NOT mark the order as stale-cleaned.
  - Fast path: if the batch result indicates `ORDER_SIZE_DRIFT_TARGETED` (`dexbot_state_recovery.ts:273`), a targeted repair applies the correction directly and skips `_triggerStateRecoverySync`.

---

## State / Lifecycle

- `INV-STATE-001` Bootstrap suppresses invariant checks
  - While `isBootstrapping()` is true, `_verifyFundInvariants` must be suppressed.
  - Suppression covers `recalculateFunds` and `_updateOrder` trigger paths.

- `INV-STATE-002` Recovery validation not masked by bootstrap
  - `_performStateRecovery` must detect drift even when `isBootstrapping()` is true.
  - Bootstrap suppression of invariant checks must not also suppress recovery validation.

- `INV-STATE-003` Grid resize respects budget after capping
  - BUY allocation must not exceed calculated budget after `_recalculateGridOrderSizesFromBlockchain` capping.

---

## Fund Registry

- `INV-REG-001` Cross-bot allocation ≤ proportional share
  - Per-bot committed amounts (sum of on-chain orders) must not exceed `totalChainBalance × allocatedPercent`.
  - Violation triggers an error-level log entry (not silent), with tolerance `max(PERCENT_TOLERANCE * 3, 0.15)`.
  - Registry registration is pre-flight + atomic; only shared-account bots register (`dexbot.ts:617` filters `accountGroups[a].length > 1`), and registration completes before any shared-account bot starts.
  - Release happens in `DEXBot.shutdown`.

- `INV-REG-002` Async-locked registry writes
  - All `fund_registry` mutations (register, update, release) must hold an async lock.
  - Concurrent writes from multiple bots sharing the same account must be serialized.

---

## Subscriptions

- `INV-SUB-001` Fill discovery via periodic polling
  - `startFillPolling` invokes `processObjects` per active subscription every `FILL_POLL_INTERVAL_MS` (default 60s).
  - `entry.active` and `entry.reconnecting` flags gate per-subscription work.
  - `fillPollInProgress` flag prevents overlapping poll ticks.

---

## Broadcast

- `INV-BROADCAST-001` BROADCAST_DEADLINE graceful recovery
  - On `BroadcastUncertainError`, the bot must:
    - Retry once with a fresh deadline window (`_executeWithRetryOnUncertain`).
    - Skip retry when `err.partialOnChainState` is true (pair-mode grouped execution).
    - After retry expiry, reconcile — `AsyncLock` is re-entrant so no special `fillLockAlreadyHeld` parameter is needed.
  - Daemon broadcast (`broadcastWithDeadline`) pins all
    `CREDENTIAL_DAEMON_BROADCAST_RETRIES` attempts to one node; only when they
    all fail with provably untransmitted failures (pre-send errors only) does
    it report the node to the health ledger (threshold → blacklist + shared
    health-cache exclusion, logged) and rotate to the next best node. Re-signing
    an uncertain broadcast would duplicate a landed transaction on chain (new
    tx ID per signature), so BROADCAST_DEADLINE is reported to the bot and
    retries happen only after chain verification.

- `INV-BROADCAST-002` Deadlock-free reconcile after uncertain broadcast
  - `_reconcileAfterUncertainBroadcast` does not need a `fillLockAlreadyHeld` flag because `AsyncLock` is re-entrant — a second `acquire()` from within the same execution context runs the callback directly instead of queueing.
  - The lock hierarchy requires `_syncLock(2)` to be acquired before `_gridLock(3)` in all paths; no `gridLockAlreadyHeld` bypass flag exists.

- `INV-BROADCAST-003` Verify-before-retry; never re-sign an uncertain broadcast
  - An uncertain outcome (RPC timeout, connection dropped with a response pending, unknown code) must never be re-signed — a re-sign would land a duplicate transaction on chain (new tx ID per signature).
  - Retries are limited to provably-untransmitted failures (pre-send connection/frame errors) and re-broadcast happens only after an AUTHORITATIVE absence read (non-empty, non-truncated chain read containing none of the batch's CREATEs).
  - Direct-key and claw broadcast paths classify failures via `modules/broadcast_failure.ts` and surface typed `BroadcastUncertainError` so the COW machinery engages instead of a blind error.

- `INV-BROADCAST-004` Truncated/empty reads are ambiguous, not authoritative absence
  - A `get_full_accounts` window capped at the order limit omits the freshest orders (by_account index = seller,id ascending — fresh creates sort last), so absence on a truncated/empty read can never free slots/capital, confirm a cancel, discard a batch, or clear pending-broadcast protection.
  - All absence decisions use `readOpenOrdersWithMeta`; truncated/empty snapshots defer (keep protection + request structural resync) instead of acting.

## Change Policy

- Any intentional invariant change must:
  - Update this document in the same PR/commit.
  - Include explicit rationale and risk note.
  - Add or update regression tests in the relevant test files.

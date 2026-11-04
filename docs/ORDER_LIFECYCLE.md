# Order Lifecycle Registry

> How the engine answers one question — *does this order exist on chain, and how
> sure are we?* — from one record instead of seven.
>
> **See also:** [ORDER_ENGINE_POST_1.0_RETROSPECTIVE.md](ORDER_ENGINE_POST_1.0_RETROSPECTIVE.md) (§9.11.3) ·
> [COW_INVARIANTS.md](COW_INVARIANTS.md#order-lifecycle-order_lifecyclemd) ·
> [TIMING_INVENTORY.md](TIMING_INVENTORY.md).

## The problem this replaces

An order's chain existence used to be tracked by seven independent structures,
each with its own clock:

| Structure | Kind | Clock |
|---|---|---|
| `_pendingBroadcasts` | fingerprint → entry | `PENDING_BROADCAST_TTL_MS` (30 min) |
| `createUncertain` | slot flag | none (persisted across restarts) |
| `_committedOrderIds` + `_committedOrderIdsBuiltAt` | Set + stamp | `SYNC_LOCK_TIMEOUT_MS` (20 s) |
| `_orderIdAssignedAt` | orderId → timestamp | none |
| `_placedAt` | orderId → timestamp | `SURPLUS_CANCEL_GRACE_MS` (15 min) |
| `_chainSizeAppliedFills` | orderId → marker | `CHAIN_SIZE_APPLIED_MARKER_TTL_MS` (5 min) |
| `_lastUnmatchedChainOrders` + `…At` | array | none |

Four read sites consulted four different **subsets**:

| Site | Consulted |
|---|---|
| `modules/order/accounting.ts` (fund recalibration) | committed **and** assigned |
| `modules/order/grid_reconcile.ts` (startup phantom cleanup) | assigned only |
| `modules/order/sync_engine.ts` pass 1 | committed only |
| `modules/order/grid_reconcile_internal.ts` | `createUncertain` flag only |

Each site was locally correct. Together they could give four different answers
for the same order — which is why the resulting bugs ("phantom cleanup
virtualized a live order", "lost receipt became a clean hole the next cycle
re-CREATED") kept re-appearing in a new path after each fix.

## The model

`modules/order/lifecycle.ts` owns one record per **slot** (a slot is the stable
identity across its order incarnations: intent → chain id → partial → gone).

```
phase:    intent | broadcasting | landed | filling | gone | unknown
evidence: none | local | broadcast-receipt | chain-snapshot | fill-history | adoption
```

Clocks live on the record, once:

- `recordedAt` — when the current phase was recorded (our clock)
- `observedAt` — when the **chain** last told us anything (`0` = never)
- `assignedAt` / `placedAt` / `committedAt` — the legacy per-structure stamps
- `appliedFillInt` / `appliedFillAt` — the pass-1 resize dedupe marker

`unknown` is a real phase, not an absence. A lost receipt, an ambiguous read and
an unparseable chain entry all land there, and `mayExistOnChain` is `true` for
it. Reading `unknown` as "gone" is the bug class this whole module exists to
make unrepresentable.

## Evidence is monotonic

`evidence` records *how* we know the current phase, ranked weakest → strongest:
`none` < `local` < `broadcast-receipt` < `adoption` < `chain-snapshot` <
`fill-history`.

Within one phase the rank can only go up. The write funnel only knows the LOCAL
slot state ("this slot is ACTIVE"), so it reports `local`; that must not
overwrite what a sync pass just observed (`chain-snapshot`), or the registry
would claim a purely local basis for the strongest thing we know about the
order. A PHASE CHANGE is new information, so it adopts its own evidence.

## Clocks cannot be refreshed for free

- `observedAt` advances only for chain-backed evidence (`chain-snapshot`,
  `fill-history`, `adoption`). Local bookkeeping cannot move "when did the chain
  last tell us anything".
- `recordedAt` — the anchor of the unresolved bound — advances only when the
  phase changes or chain-backed evidence arrives. Re-asserting the same
  unresolved phase is not new information: refreshing the clock for it would
  keep `isInFlight()` true forever, which is the opposite of the documented
  escape hatch. A bot that mutates a slot every cycle (a re-plan, a size tweak)
  re-asserts `unknown` on every write, so this rule is what makes the bound real.

## Legacy structures are views, not copies

Six of the seven are now live `Map`/`Set` views onto the registry
(`LifecycleMapView` / `LifecycleSetView`):

| Structure | View |
|---|---|
| `_placedAt` | `registry.placedAt` |
| `_orderIdAssignedAt` | `registry.assignedAt` |
| `_committedOrderIds` | `registry.committedIds` |
| `_committedOrderIdsBuiltAt` | `registry.committedBuiltAt` |
| `_pendingBroadcasts` | `registry.pendingBroadcasts` |
| `_chainSizeAppliedFills` | `registry.appliedFills` |

Writes through them land on the record; reads see the record. Old call sites
keep working; there is one copy of the data.

`createUncertain` is folded in at read time (`getSlotLifecycle` reports
`unknown`), so the persisted flag and the registry cannot disagree.

`_lastUnmatchedChainOrders` is deliberately **not** a view: it is a per-read
*output* of the sync engine ("chain orders this snapshot could not place"), not
lifecycle state. It is regenerated from each snapshot and must not be mistaken
for evidence about a specific slot.

`_committedOrderIdsBuiltAt` is the registry's single `committedBuiltAt` stamp:
the COW engine publishes a whole Set at once, and the protection window is
measured from that publish, not from each id.

## The read surface

```ts
const view = manager.getLifecycle(orderIdOrSlotId);
view.phase;                 // 'landed' | 'unknown' | ...
view.isConfirmedGone;        // only when the chain confirmed absence
view.mayExistOnChain;        // broadcasting | landed | filling | unknown
view.isInFlight();           // absence is NOT yet trustworthy
view.isFreshlyPlaced();      // inside the surplus-cancel grace
view.isRecentlyCommitted();  // inside the COW commit window
view.appliedFillMatches(n);  // pass-1 resize dedupe
```

`isInFlight()` is the single definition of the "absence is not trustworthy"
guard. It is time-bounded (2× `PENDING_BROADCAST_TTL_MS`) so a lagging node
cannot park the grid, matching the escape hatch each old per-site guard carried.
All three absence-decision sites ask it, through `readSlotLifecycle`: the sync
pass-1 phantom cleanup, the startup reconcile, and the fund recalibration sweep.
Asking a *subset* of it is what re-opened the bug class: the sync engine used to
consult the committed window and the fresh-assignment window separately and
never the unresolved phases, so it could virtualize an order whose CREATE
receipt was merely lost.

`readLifecycle(manager, id)` reads through `getLifecycle` and falls back to
synthesizing a record from the raw maps, so partial test doubles keep working
while the *vocabulary* stays unified. `readSlotLifecycle(manager, slot)` is the
preferred form wherever the slot object is at hand: a slot can carry evidence
the registry does not (the persisted `createUncertain` marker), and an
orderId-keyed read would silently ignore it.

Two read rules:

- **Reads do not write.** `getSlotLifecycle` reports `unknown` for a slot that
  carries `createUncertain` via `withPhase`, which never touches the record.
  Recording it on read would refresh `recordedAt` every call and keep the
  unresolved bound alive forever. A `withPhase` view over a slot that was never
  recorded has no clock at all (`recordedAt: 0`), so an aged marker cannot look
  fresh on every read.
- **Unresolved evidence is sticky — but not eternal.** A slot mutation that
  clears the chain id uses `markIntentIfResolved`: it will not downgrade an
  `unknown`/`broadcasting` record to `intent` while the uncertainty is inside the
  bound. Past the bound the release has already happened for every decision
  (`isInFlight()` is false), so the same call resolves the phase to `intent`
  instead of leaving a suppression nothing honours and `mayExistOnChain` true
  forever. Only an explicit decision (`markIntent`) or the chain can resolve it
  sooner.

## Writes are funnelled

Every order mutation goes through `_applyOrderUpdate`, which calls
`_syncLifecycleFromMutation(previous, next, context)`. That funnel is the ONLY
writer of phase, `assignedAt` and `placedAt` — the stamps used to be written a
second time at the call site, which is how two copies of every clock appear. A
`createUncertain` write (including the persisted marker restored at startup and
the load-time sanitizer) is folded into `phase: 'unknown'` automatically.

One mutation does not go through `_applyOrderUpdate`: the COW commit replaces the
master map wholesale (`_commitWorkingGrid`). It projects every slot of the
committed map through the same funnel *before* swapping, for the same reason —
the primary placement path must stamp `assignedAt`/`placedAt`, or the
fresh-placement grace is inert for every COW-created order and a competing sweep
may cancel a seconds-old order. The committed-set publish then stamps
`committedAt` for the whole map in one call (`markCommittedSnapshot`); a second
per-id stamp would only re-date the same ids.

Two distinct pending-CREATE outcomes are kept distinct:

- **resolved** (`deletePending`) → the slot is a clean `intent` again
- **abandoned** (`_expirePendingBroadcast`, TTL sweep) → `phase: 'unknown'`

Collapsing those two is how a lost receipt used to turn into a clean hole.

## Identity and cleanup

A record is keyed by slot, so a rotation updates one record instead of forking a
new one per chain id. When a chain id is retired, its index entry is dropped; a
lookup for it returns an empty view (phase `intent`, nothing on chain), not a
stale record. If a stamp was written before the slot was known, `linkOrderId`
folds the order-only record into the slot record (max of each clock) and deletes
it, so `placedAt` can never be stranded on an unreachable record.

## Invariants

- `INV-LIFE-001` Unknown is never gone. `phase === 'unknown'` implies
  `mayExistOnChain === true` and `isConfirmedGone === false`.
- `INV-LIFE-002` One record per slot. A chain-id change (rotation, re-place)
  updates the existing record; it never starts a parallel one.
- `INV-LIFE-003` No site invents its own evidence set. Absence decisions use
  `isInFlight()` (read through the slot: `readSlotLifecycle`); the committed
  guard uses `isRecentlyCommitted()`; the fresh-id guard uses
  `isRecentlyAssigned()`.
- `INV-LIFE-004` A LIVE unresolved record is never evicted. Registry pruning
  skips `unknown` and `broadcasting` records while their uncertainty is inside
  the bound; past it they are no less settled than anything else (no decision
  consults them any more), so they become evictable and the registry keeps a
  ceiling even on a bot that keeps losing CREATE receipts.
- `INV-LIFE-005` A chain entry that cannot be parsed makes its slot's absence
  UNKNOWN, never absent (`sync_engine` guard 0, mirroring the accounting
  recovery sweep's `malformedOrderIds`).
- `INV-LIFE-006` Evidence never downgrades within a phase, and `observedAt`
  advances only for chain-backed evidence.
- `INV-LIFE-007` The unresolved bound is measured from when the uncertainty was
  RECORDED. Re-asserting the same phase without new evidence does not move it.

## Tests

- `tests/test_order_lifecycle.ts` — the record model, `unknown ≠ gone`, resolved
  vs abandoned pending, the committed snapshot stamp, the COW commit
  projection, evidence monotonicity, the unresolved bound against
  re-assertions, expired-unknown resolution, eviction policy, the unified
  absence guard at the sync site, and the `readLifecycle` fallback.
- `tests/recon_fuzz.ts` — the interleaving fuzzer; asserts `INV-LIFE-004`
  coverage (`I3`/`I4`) after every event.

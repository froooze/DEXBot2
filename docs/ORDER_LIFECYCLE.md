# Order Lifecycle Registry

> How the engine answers one question — *does this order exist on chain, and how
> sure are we?* — from one record instead of seven.

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

`readLifecycle(manager, id)` reads through `getLifecycle` and falls back to
synthesizing a record from the raw maps, so partial test doubles keep working
while the *vocabulary* stays unified.

Two read rules:

- **Reads do not write.** `getSlotLifecycle` reports `unknown` for a slot that
  carries `createUncertain` via `withPhase`, which never touches the record.
  Recording it on read would refresh `recordedAt` every call and keep the
  unresolved bound alive forever.
- **Unresolved evidence is sticky.** A slot mutation that clears the chain id
  uses `markIntentIfResolved`: it will not downgrade an `unknown`/`broadcasting`
  record to `intent`. Only an explicit decision (`markIntent`, i.e. the
  sanitizer clearing the marker) or an answer from the chain can do that.

## Writes are funnelled

Every order mutation goes through `_applyOrderUpdate`, which calls
`_syncLifecycleFromMutation(previous, next, context)`. No call site has to
remember which structure to touch. A `createUncertain` write (including the
persisted marker restored at startup and the load-time sanitizer) is folded into
`phase: 'unknown'` automatically.

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
  `isInFlight()`; the committed guard uses `isRecentlyCommitted()`; the fresh-id
  guard uses `isRecentlyAssigned()`.
- `INV-LIFE-004` Unresolved records are never evicted. Registry pruning skips
  `unknown` and `broadcasting`.
- `INV-LIFE-005` A chain entry that cannot be parsed makes its slot's absence
  UNKNOWN, never absent (`sync_engine` guard 0, mirroring the accounting
  recovery sweep's `malformedOrderIds`).

## Tests

- `tests/test_order_lifecycle.ts` — the record model, `unknown ≠ gone`, resolved
  vs abandoned pending, the committed snapshot stamp, facade equivalence,
  eviction policy, and the `readLifecycle` fallback.
- `tests/recon_fuzz.ts` — the interleaving fuzzer; asserts `INV-LIFE-004`
  coverage (`I3`/`I4`) after every event.

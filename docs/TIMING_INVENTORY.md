# Timing Window Inventory

> Every `TIMING` window is classified, has a rationale, and — if it is
> self-healing — names the evidence that would let it be deleted.
> `tests/test_timing_policy.ts` fails when a new unclassified window appears.

Source of truth: `modules/timing_policy.ts` (`TIMING_CLASSIFICATIONS`).

## Why an inventory

The engine has **84** timing knobs. That number grew because every "the state
was briefly wrong" bug was fixed by adding a wait, and nothing ever removed one.
A wait is a substitute for evidence: it says *wait, then guess*. Some of that is
unavoidable — a block takes as long as it takes — but most of it is not, and the
difference has to be written down or it will keep growing.

## The four kinds

| Kind | Meaning | Growth policy |
|---|---|---|
| `external` | Encodes how long the **outside world** takes (block time, node lag, RPC deadline, poll cadence). | Allowed. New ones must name the external quantity. |
| `bound` | A leak/GC bound. Caps retention; **cannot** produce a wrong decision. | Allowed. Deleting one leaks memory, not correctness. |
| `policy` | A deliberate product choice (grace, cooldown, backoff, attempt budget). | Allowed, but each is behaviour encoded in milliseconds instead of in state — keep it out of correctness paths. |
| `self-healing` | Compensates for our **own** lost or divergent state. | **Removal target.** The fix is evidence, not patience. |

(`derived` is an orthogonal flag: the value is computed from another timing.)

## Current inventory

```
external      33
bound         19
policy        26
self-healing   6
```

## Removal targets

These six exist only because the engine could not tell two local states apart.
`modules/order/lifecycle.ts` now records the difference explicitly, so each has a
named replacement — the window can go once that path is proven in live
operation.

| Window | Why it exists | Delete when |
|---|---|---|
| `SURPLUS_CANCEL_GRACE_MS` | A just-placed order may be missing from a slightly stale reconcile snapshot. | The COW planner reads `phase: 'landed'` from the lifecycle record instead of tolerating its absence. |
| `PENDING_BROADCAST_TTL_MS` | A CREATE whose receipt was lost used to be forgotten after a timeout. | Lost receipts are resolved by evidence (adoption or confirmed absence). The correctness role is already gone — only the retention cap remains. |
| `CHAIN_SIZE_APPLIED_MARKER_TTL_MS` | Dedupe marker for a resize already absorbed by sync pass 1. | The fill-history path identifies an applied resize from the lifecycle record instead of a timestamped marker. |
| `STRUCTURAL_REBUILD_DEFER_MAX_MS` | Caps how long a fill-driven rebalance may defer behind a structural rebuild. | The rebuild publishes a completion event the rebalance can await. |
| `FILL_BROADCAST_DEFER_MAX_MS` | Bound on fill-consumer deferral while a broadcast is unresolved. | The fill consumer queries the lifecycle phase instead of a clock. |
| `FILL_DEDUPE_WINDOW_MS` | Coalescing window for duplicate fill events. | Fill identity is a chain tuple (tx+op) everywhere, making the window redundant with that key. |

`SYNC_LOCK_FORCE_RELEASE_AGE_MS` is classified `bound`, not `self-healing`: it is
a liveness escape hatch for a held lock, which no amount of evidence can
replace.

## Derived timings

Two values are computed from others rather than declared. Both derivations run
**after** the settings merge in `modules/constants.ts`, and a broken ordering
throws at load time instead of failing silently at runtime:

- `SYNC_LOCK_FORCE_RELEASE_AGE_MS = SYNC_LOCK_TIMEOUT_MS × 2`
- `FILL_BROADCAST_DEFER_MAX_MS = max(declared, BROADCAST_STALE_CLEAR_MS + BROADCAST_DEFER_SAFETY_MARGIN_MS)`

They must stay declared in `TIMING_CLASSIFICATIONS` with `derived: true`; the
test asserts the relationship still holds whatever a deployment overrides.

## Adding a window

1. Add the key to `TIMING` in `modules/constants.ts`.
2. Add a `TIMING_CLASSIFICATIONS` entry in `modules/timing_policy.ts` — kind,
   one-line rationale, and for `self-healing` the removal precondition.
3. If it looks like a window but is not one (a count, a unit, a flag), add it to
   `NON_WINDOW_KEYS` instead.

Skipping step 2 or 3 fails `npm test`.

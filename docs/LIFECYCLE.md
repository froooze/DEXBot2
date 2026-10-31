# DEXBot2 Lifecycle — End-to-End Walkthrough

This is the **one-page map** for newcomers. It stitches together the flows that are
otherwise spread across `architecture.md` and `developer_guide.md` into two concrete
lifecycles (fill-driven and maintenance-driven) plus the startup sequence. Read this
first; follow the file/function references into the deeper docs.

> All code references use `file:line` so you can jump straight to the source.

---

## 1. System Context

Who talks to what. DEXBot2 is a long-running Node process that both *reads* the
BitShares chain/market and *writes* limit orders back to it.

```mermaid
graph TB
    OP[Operator<br/>CLI / PM2 / unlock.ts]
    CHAIN[(BitShares Chain<br/>fills, open orders, balances)]
    MKT[Market Data<br/>LP pools / order book / AMA feed]
    STORE[(Local Storage<br/>profiles/orders/*.json<br/>profiles/bots.json)]
    BOT[DEXBot2 Process<br/>dexbot_class.ts]

    OP -->|configure / start| BOT
    CHAIN -->|fill events op-4| BOT
    CHAIN -->|open-order poll| BOT
    MKT -->|price / AMA center| BOT
    BOT -->|CREATE / UPDATE / CANCEL| CHAIN
    BOT -->|grid snapshot| STORE
    STORE -->|restore grid| BOT
```

Three inputs drive everything: **fill events** (reactive), **market/AMA price**
(periodic), and **config/storage** (startup + recovery).

---

## 2. Startup / Bootstrap Sequence

Runs once per bot launch. Goal: decrypt keys, load metadata, rebuild the master
grid from either config or the persisted snapshot, then hand off to the runtime
loops.

```mermaid
sequenceDiagram
    participant OP as Operator
    participant CL as dexbot_class.ts
    participant CD as Credential Daemon
    participant AM as Asset Metadata
    participant OM as OrderManager
    participant CH as Chain (open orders)
    participant ST as Storage

    OP->>CL: start(botKey)
    CL->>CD: decrypt private key (AES, interactive/one-shot)
    CD-->>CL: unlocked key
    CL->>AM: load precision, fees, asset IDs
    CL->>ST: load persisted grid snapshot (if present)
    ST-->>CL: orders/botKey.json
    CL->>OM: init Master Grid (config OR snapshot)
    CL->>CH: SyncEngine 2-pass (grid<->chain match)
    CH-->>OM: detect partials / stale / phantom
    CL->>CL: start maintenance loop + market adapter (if AMA)
    CL-->>OP: bot live, awaiting fills / ticks
```

Key references:
- Credential unlock: `modules/credential_runtime.ts`, `CREDENTIAL_SECURITY.md`
- Master Grid init + COW: `docs/architecture.md` §"Copy-on-Write (COW) Grid Pattern"
- SyncEngine 2-pass: `modules/order/sync_engine.ts`, `docs/GRID_RECONCILE.md`

---

## 3. Lifecycle A — Fill-Driven (Reactive)

This is the hot path. A limit order gets filled on-chain and the bot must rebuild
grid symmetry, credit proceeds, and broadcast replacement orders — all inside a
single Copy-on-Write rebalance cycle.

```mermaid
sequenceDiagram
    participant CH as Chain (op-4 fill)
    participant Q as _incomingFillQueue
    participant FR as dexbot_fill_runtime
    participant OM as OrderManager
    participant WG as WorkingGrid (COW)
    participant AC as Accounting (SSOT)
    participant ST as Strategy (calculateTargetGrid)
    participant CO as chain_orders (broadcast)
    participant STORE as Storage

    CH->>Q: enqueue fill(s)  (createFillCallback, dexbot_fill_runtime.ts)
    FR->>FR: drain queue -> _processFillsWithBatching
    FR->>OM: processFilledOrders()  (manager.ts)
    OM->>AC: processFillAccounting()  (single call, batch)
    AC-->>WG: chainFree += combined proceeds
    OM->>ST: calculateTargetGrid()  (rotations + boundary shift)
    ST-->>WG: mutated WorkingGrid only
    OM->>CO: updateOrdersOnChainBatch()  (atomic broadcast)
    CO-->>CH: CREATE / CANCEL orders
    CO-->>OM: confirm
    OM->>WG: commit WorkingGrid -> Master Grid
    OM->>STORE: persistGrid()  (snapshot after confirm)
```

Why it matters:
- **Gap-slot batching** (batch size = grid gap-slot count + 1, `DEXBot._getGapSlotBatchSize`) keeps bursts
  deterministic — see `docs/architecture.md` §"Fill Processing Pipeline".
- **Single rebalance cycle**: all fills in a batch share one broadcast, so proceeds
  are immediately available for replacement sizing (no split-across-cycles delay).
- **Replay-safe accounting**: processed-fill keys prevent double-credit on retries
  (`modules/dexbot_fill_runtime.ts`, `PROCESSED_FILL_PERSISTENCE_MODES`).

References: `modules/dexbot_fill_runtime.ts`, `modules/order/manager.ts`,
`docs/FUND_MOVEMENT_AND_ACCOUNTING.md`.

---

## 4. Lifecycle B — Maintenance / AMA Signal-Driven (Periodic)

Runs on a timer (and on AMA center updates). The grid is *not* rebuilt from fills
here; instead funds are re-synced, the AMA center is promoted to the grid center,
and the grid is recalculated against the latest market view.

```mermaid
sequenceDiagram
    participant MA as Market Adapter (AMA)
    participant CL as dexbot_class.ts
    participant RT as maintenance_runtime
    participant AC as Accounting
    participant GD as Grid (recalculateGrid)
    participant CO as chain_orders
    participant STORE as Storage

    MA->>CL: AMA center snapshot updated
    CL->>CL: _performPeriodicGridChecks()  (dexbot_class.ts)
    CL->>RT: performPeriodicGridChecks()  (dexbot_maintenance_runtime.ts)
    RT->>RT: _runGridMaintenance('periodic')  (dexbot_class.ts, called from maintenance)
    RT->>RT: executeMaintenanceLogic()  (dexbot_maintenance_runtime.ts)
    RT->>AC: recalculate funds from balances
    RT->>GD: promote AMA center -> grid center
    RT->>GD: recalculateGrid()  (grid.ts)
    GD->>GD: rebuild levels via WorkingGrid (COW)
    RT->>CO: broadcast adjustments (if any)
    RT->>STORE: persistGrid()
```

Two triggers feed this loop:
1. **Timer** — periodic fund sync + grid checks (`_performPeriodicGridChecks`).
2. **AMA center change** — `market_adapter` recomputes the adaptive moving average;
   when the center moves enough it promotes to the grid center and forces a recalc
   (`modules/dexbot_maintenance_runtime.ts`, `market_adapter/market_adapter.ts`).

The AMA signal stack (AMA/Kalman/Hurst/PE) is *research-tuned* in `analysis/` and
*consumed* here at runtime — see `analysis/README.md` for the tooling that produces
the parameters.

> Note: `runMaintenance()` is a **different** subsystem — the credit/MPA debt
> runtime (`modules/credit_runtime.ts`, `runMaintenance()`), reached via
> `_runCreditRuntimeMaintenance` (`dexbot_class.ts`). The grid maintenance
> chain above is the one that matters for order/price upkeep.

References: `modules/dexbot_class.ts` (`_performPeriodicGridChecks` →
`_runGridMaintenance`) → `modules/dexbot_maintenance_runtime.ts`
(`performPeriodicGridChecks` → `executeMaintenanceLogic`),
`docs/GRID_RECALCULATION.md`, `docs/GRID_RECONCILE.md`.

---

## 5. Cross-Cutting Invariants (read before touching anything)

These are the rules that make the two lifecycles safe. They are *convention-
enforced*, not compiler-enforced — learn them or you will introduce fund bugs.

| Invariant | Rule | Reference |
|---|---|---|
| **COW boundary** | All grid mutations happen on the WorkingGrid; Master Grid is frozen and only committed after chain confirmation. | `docs/developer_guide.md` §"Copy-on-Write (COW) Development Rules" |
| **Fund SSOT** | `Accounting` owns every fund number. Nothing else computes available funds. | `docs/architecture.md` §"Fund Flow Architecture" |
| **Replay-safe fills** | A fill is credited exactly once via processed-fill keys; retries are idempotent. | `modules/dexbot_fill_runtime.ts` |
| **Single broadcast per cycle** | One `updateOrdersOnChainBatch` per rebalance — never scatter writes. | `docs/architecture.md` §"Fill Processing Pipeline" |
| **Slot price = genesis level** | Every emitted order's price must equal `priceForSlot(idx, genesis)` for its slot — range guards cannot substitute for grid membership; off-grid emissions are blocked. | `docs/GRID_PRICE_INVARIANT.md` |
| **Browser/Node split** | Heavy runtime is Node-only; never import it from a browser bundle. | `AGENTS.md` "Browser-Safe Surface", `package.json` "browser" field |
| **Lock ordering** | Fill drain and maintenance must not run a rebalance concurrently. | `docs/developer_guide.md` §"Startup Sequence & Lock Ordering" |

---

## 6. File Map (where to go next)

| You want to understand… | Start here |
|---|---|
| How a fill becomes orders | `modules/dexbot_fill_runtime.ts` → `modules/order/manager.ts` |
| Grid math / recalculation | `modules/order/grid.ts`, `docs/GRID_RECALCULATION.md` |
| Funds & accounting | `modules/order/accounting.ts`, `docs/FUND_MOVEMENT_AND_ACCOUNTING.md` |
| Periodic loop & AMA hook | `modules/dexbot_maintenance_runtime.ts`, `modules/dexbot_class.ts` (`_performPeriodicGridChecks`, `_runGridMaintenance`) |
| Market signal source | `market_adapter/market_adapter.ts`, `analysis/README.md` |
| Startup & orchestration | `modules/dexbot_class.ts`, `docs/developer_guide.md` §"Startup Sequence" |
| Why COW exists | `docs/architecture.md` §"Copy-on-Write (COW) Grid Pattern", `docs/COW_INVARIANTS.md` |

---

### TL;DR mental model

> Blockchain fill (or AMA tick) → enqueue → drain in fixed-cap batches →
> credit proceeds to Accounting (SSOT) → mutate **WorkingGrid** only →
> calculate target grid → **single** atomic broadcast → commit WorkingGrid to
> Master → persist snapshot. Master Grid is immutable; everything else is a
> disposable copy until the chain confirms.

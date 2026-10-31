# DEXBot2 Architecture

This document provides a high-level overview of the DEXBot2 architecture, module relationships, and key data flows.

> **For practical development guidance**, see [developer_guide.md](developer_guide.md) for quick start, glossary, module deep dive, and common development tasks.

---

## System Overview

DEXBot2 is a grid trading bot for the BitShares blockchain. It maintains a geometric grid of limit orders that automatically rebalance as the market moves, capturing profit from price oscillations.

### Core Concepts

- **Grid**: A geometric array of price levels with orders placed at each level
- **Spread Zone**: A buffer of empty slots between buy and sell orders (constant width)
- **Order States**: VIRTUAL (planned) → ACTIVE (on-chain) → PARTIAL (partially filled)
- **Fund Tracking**: Atomic accounting system preventing race conditions and overdrafts

### Design Philosophy

DEXBot2 prioritizes **simplicity and operational efficiency** over complex partial-handling mechanics:

1. **Constant Spread**: The spread zone width remains fixed at `targetSpreadPercent`, eliminating dynamic inflation triggers.
2. **Immediate Dust Cancellation**: Sub-threshold partials are cancelled on-chain as soon as detection runs; surviving non-dust partials are handled by ordinary fund-driven rebalancing without complex merge/split logic.
3. **Minimal Blockchain Interaction**: Fund-driven rebalancing occurs once per fill batch, not per-partial. Grid generation uses only available funds—no forced allocations.
4. **Closed-Loop Market Dynamics**: The boundary-crawl mechanism naturally handles price movement and fill flows without special-case logic.
5. **Powerful Maintenance Tools**: Periodic grid regeneration, recovery retries, and fund invariant verification keep the system healthy over long operations.

---

## Top-Level Data Flow

The diagram below shows DEXBot2 from a **data perspective**: what data enters the system, how it moves through each engine, and what leaves as blockchain operations or persisted state.

```mermaid
graph TB
    subgraph "INPUTS"
        CFG[bots.json<br/>grid params, funds, pair]
        GS[general.settings.json<br/>timing, thresholds]
        KEYS[keys.json AES encrypted<br/>+ interactive unlock / one-shot local bootstrap]
        PERSIST[orders/botKey.json<br/>grid snapshot,<br/>feesOwed, boundaryIdx]
        FILLEV[Fill Events real-time<br/>BitShares block op-4]
        OPENORD[Open Orders polling<br/>chain open-order list]
        BALANCES[Account Balances<br/>FREE + COMMITTED assets]
        PRICE[Market Price<br/>pool or order-book]
    end

    subgraph "BOOTSTRAP - once at startup"
        AUTH[Credential Daemon<br/>Decrypt private key]
        ASSETMETA[Asset Metadata<br/>precision, fees, IDs]
        INITGRID[Initial Grid<br/>geometric price levels<br/>order sizes per side]
    end

    subgraph "CORE ENGINE - OrderManager"
        MASTERGRID[Master Grid - immutable/frozen<br/>slot-id, price, size, state<br/>orderId, blockchain, grid, proceeds]
        TWOPASS[SyncEngine<br/>2-pass: grid-to-chain then chain-to-grid<br/>match orderId, detect partials, flag stale]
        FUNDS["Accounting - SSOT for funds<br/>available, virtual, committed<br/>btsFeesOwed<br/>Avail = max 0 ChainFree minus Virtual minus Fees"]
        TARGET[Strategy Engine<br/>calculateTargetGrid<br/>boundary-crawl pivot<br/>partial correction, rotation]
        WORKGRID[WorkingGrid - COW copy<br/>all mutations here only<br/>commit to Master on confirmation]
        FILLQUEUE[Fill Queue<br/>AsyncLock + dedup 5-60 min]
        BATCHER[Fixed-Cap Batcher<br/>queue within cap: unified batch<br/>queue above cap: chunk at cap size<br/>cap = gapSlots + 1]
    end

    subgraph "OUTPUTS"
        OPS[Blockchain Operations<br/>CREATE / UPDATE / CANCEL<br/>limit orders on BitShares]
        SNAP[Grid Snapshot<br/>profiles/orders/botKey.json]
        LOGS[Logs and Metrics<br/>profiles/logs/botName.log<br/>queue depth, latency, health]
    end

    KEYS --> AUTH --> ASSETMETA
    CFG --> INITGRID
    GS --> INITGRID
    ASSETMETA --> INITGRID
    PERSIST --> MASTERGRID
    INITGRID --> MASTERGRID

    PRICE --> FUNDS
    BALANCES --> FUNDS
    BALANCES --> TWOPASS
    OPENORD --> TWOPASS
    TWOPASS --> FUNDS
    TWOPASS --> MASTERGRID

    FILLEV --> FILLQUEUE
    OPENORD --> FILLQUEUE
    FILLQUEUE --> BATCHER
    BATCHER --> WORKGRID

    MASTERGRID --> WORKGRID
    FUNDS --> TARGET
    WORKGRID --> TARGET
    TARGET --> WORKGRID
    WORKGRID --> OPS
    OPS --> MASTERGRID

    MASTERGRID --> SNAP
    FUNDS --> LOGS
    BATCHER --> LOGS
    OPS --> LOGS
```

### Key Design Principles

| Principle | Mechanism |
|---|---|
| **Immutability** | Master Grid is frozen; all changes go through a disposable WorkingGrid (Copy-on-Write) |
| **Single Source of Truth** | Accounting engine owns all fund data; everything reads from it |
| **Event-driven + Polling** | Fill Events (real-time) and Open-Order polling feed the same queue |
| **Fixed-Cap Batching** | Deterministic batching with hard cap per broadcast (cap = gapSlots + 1 fills) |
| **Persistence** | Grid snapshot written after every confirmed blockchain commit |

---

## Module Architecture

```mermaid
graph TB
    subgraph "Entry Points"
        CLI[dexbot.ts]
        BOT[bot.ts]
        PM2[pm2.ts]
        UNLOCK[unlock.ts]
        CRED_DAEMON[credential-daemon.ts]
    end

    subgraph "Core Bot"
        DEXBOT[DexBotClass<br/>modules/dexbot_class.ts]
        FILL_RUNTIME[FillRuntime<br/>modules/dexbot_fill_runtime.ts]
        MAINT_RUNTIME[MaintenanceRuntime<br/>modules/dexbot_maintenance_runtime.ts]
        CONSTANTS[Constants<br/>modules/constants.ts]
        FUND_REGISTRY[FundRegistry<br/>modules/fund_registry.ts]
        SETTINGS_MERGE[SettingsMerge<br/>modules/settings_merge.ts]
        CRED_RUNTIME[CredentialRuntime<br/>modules/credential_runtime.ts]
    end

    subgraph "Order Management System"
        MANAGER[OrderManager<br/>modules/order/manager.ts]

        subgraph "Specialized Engines"
            ACCOUNTANT[Accountant<br/>accounting.ts]
            STRATEGY[StrategyEngine<br/>strategy.ts]
            SYNC[SyncEngine<br/>sync_engine.ts]
            GRID[Grid<br/>grid.ts]
        end

        WORKGRID[WorkingGrid<br/>working_grid.ts]
        GRID_RECONCILE[GridReconcile<br/>grid_reconcile.ts]
        COW_RUNTIME[COWRuntime<br/>dexbot_cow_runtime.ts]
        UTILS[Utils<br/>utils/]
        LOGGER[Logger<br/>logger.ts]
        FILL_STORE[ProcessedFillStore<br/>processed_fill_store.ts]
    end

    subgraph "Blockchain Layer"
        CHAIN_ORDERS[ChainOrders<br/>modules/chain_orders.ts]
        ACCOUNT_ORDERS[AccountOrders<br/>modules/account_orders.ts]
        ACCOUNT_BOTS[AccountBots<br/>modules/account_bots.ts]
        NODE_MGR[NodeManager<br/>modules/node_manager.ts]
        BTS_CLIENT[BitSharesClient<br/>modules/bitshares_client.ts]
    end

    subgraph "Market Adapter"
        MA[MarketAdapter<br/>market_adapter/market_adapter.ts]
        MA_SVC[AdapterService<br/>core/market_adapter_service.ts]
        AMA_RUNNER[AMA Signal Runner<br/>ama_signal_runner.ts]
        KIBANA[inputs/kibana_source.ts]
        LP_FETCH[inputs/fetch_lp_data.ts]
        STRATEGIES[core/strategies/]
    end

    CLI --> DEXBOT
    BOT --> DEXBOT
    PM2 --> DEXBOT
    UNLOCK --> CRED_DAEMON
    CRED_DAEMON --> DEXBOT

    DEXBOT --> MANAGER
    DEXBOT --> FILL_RUNTIME
    DEXBOT --> MAINT_RUNTIME
    DEXBOT --> CONSTANTS
    DEXBOT --> FUND_REGISTRY
    DEXBOT --> SETTINGS_MERGE
    DEXBOT --> CRED_RUNTIME

    MANAGER --> ACCOUNTANT
    MANAGER --> STRATEGY
    MANAGER --> SYNC
    MANAGER --> GRID
    MANAGER --> WORKGRID
    MANAGER --> GRID_RECONCILE
    MANAGER --> UTILS
    MANAGER --> LOGGER
    MANAGER --> COW_RUNTIME
    MANAGER --> FILL_STORE

    ACCOUNTANT --> FUND_REGISTRY
    STRATEGY --> UTILS
    SYNC --> UTILS
    GRID --> UTILS

    COW_RUNTIME --> CHAIN_ORDERS
    SYNC --> ACCOUNT_ORDERS
    MANAGER --> ACCOUNT_BOTS

    CHAIN_ORDERS --> BTS_CLIENT
    ACCOUNT_ORDERS --> BTS_CLIENT
    BTS_CLIENT --> NODE_MGR

    MA --> MA_SVC
    MA --> AMA_RUNNER
    MA_SVC --> KIBANA
    MA_SVC --> LP_FETCH
    MA_SVC --> STRATEGIES

    MA -.->|trigger files| MAINT_RUNTIME
```

## Browser-Safe Surface

DEXBot2 ships both a **Node CLI runtime** and the building blocks for an in-browser operator UI. To keep `require('fs')`, `process.kill`, and Unix-socket calls out of the browser bundle, the codebase enforces a strict Node-vs-browser split.

**Convention**: *everything is browser-safe unless listed as Node-only*. The source of truth is the `"browser"` field in `package.json`, which maps every Node-only **compiled** entry (`dist/*.js`) to `false`. The list below is documentation; always check `package.json` before reclassifying a module.

**Node-only modules** (must not be reached from a browser bundle):

| Module | Reason |
|--------|--------|
| `modules/launcher/*` | Credential daemon, bot supervisor, market-adapter runtime, monolithic runtime |
| `modules/dexbot_maintenance_runtime.ts` | Direct `fs` / `child_process` / `os` use |
| `modules/dexbot_class.ts` | Imports `dexbot_maintenance_runtime` |
| `unlock.ts`, `bot.ts`, `dexbot.ts`, `pm2.ts`, `credential-daemon.ts` | CLI entry points |
| `market_adapter/lp_chart_runner.ts` | `import { exec } from 'node:child_process'` for chart rendering |

**Environment detection** must go through `modules/env.ts` rather than inline `typeof window` / `typeof process` checks:

```javascript
import { isBrowser, hasProcess } from './env';
```

The previous 6+ inline ternaries that existed in `bitshares-native/*` and `runtime.ts` were consolidated into those helpers; do not reintroduce them.

---

## Order Manager: Central Coordinator

The `OrderManager` is the central hub that coordinates all order operations. It delegates specialized tasks to four engine modules:

### Engine Responsibilities

| Engine | File | Responsibility |
|--------|------|----------------|
| **Accountant** | `accounting.ts` | **Single Source of Truth**. Centralized fund tracking via `recalculateFunds()`, fee management, invariant verification, recovery retry state management (`resetRecoveryState()`) |
| **StrategyEngine** | `strategy.ts` | Grid rebalancing, order rotation, partial order handling, fill boundary shifts, remainder tracking |
| **SyncEngine** | `sync_engine.ts` | Blockchain synchronization, fill detection, stale-order cleanup, type-mismatch handling |
| **Grid** | `grid.ts` | Grid creation, sizing, divergence detection, remainder accuracy during capped resize |

---

## Copy-on-Write (COW) Grid Pattern

The OrderManager implements a **Copy-on-Write (COW) pattern** to protect the master grid from speculative modifications until blockchain finality is confirmed.

### Core Principle

The master grid (`this.orders`) is **immutable** - it can only be replaced atomically, never mutated in place. All speculative planning operations work on isolated copies, and the master is only updated when blockchain confirms the operation.

**Important**: Index Sets (`_ordersByState`, `_ordersByType`) are **mutable by design** but must **only be mutated through `_applyOrderUpdate()`**. Direct external mutations violate the COW invariant.

### Protection Mechanisms

| Mechanism | Location | Purpose |
|-----------|----------|---------|
| `Object.freeze()` | `manager.ts` | Master Map is frozen at initialization |
| `deepFreeze()` | `manager.ts` | Individual order objects are deep-frozen |
| `_gridVersion` | `manager.ts` | Version counter for staleness detection |
| `_gridLock` | `manager.ts` | AsyncLock serializes grid mutations |
| Encapsulation | `manager.ts` | Index Sets are private; mutations only via `_applyOrderUpdate()` |

### Master Grid Update Pattern

All master grid updates follow clone-and-replace semantics:

```javascript
// 1. Clone existing Map
const newMap = cloneMap(this.orders);

// 2. Apply mutation to clone
newMap.set(id, updatedOrder);

// 3. Atomically replace with frozen copy
this.orders = Object.freeze(newMap);
this._gridVersion++;
```

Index Sets follow the same pattern - cloned, mutated, frozen, then replaced.

### WorkingGrid Class

The `WorkingGrid` class (`modules/order/working_grid.ts`) provides isolation for speculative operations:

- **Deep clones** the master grid on construction
- Tracks **modified orders** in a Set
- Supports **staleness detection** via `baseVersion`
- **Never modifies** the master grid

### COW Rebalance Pipeline

```
┌─────────────────────────────────────────────────────────────┐
│  1. Create WorkingGrid from frozen master                   │
│     workingGrid = new WorkingGrid(masterGrid, {baseVersion})│
└─────────────────────────┬───────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│  2. Calculate target state (PURE - no side effects)         │
│     strategy.calculateTargetGrid() returns new Map          │
└─────────────────────────┬───────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│  3. Project target onto working grid                        │
│     Modifies working copy only                              │
└─────────────────────────┬───────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│  4. Validate funds & check staleness                        │
│     If stale: abort without committing                      │
└─────────────────────────┬───────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│  5. Submit to blockchain & wait for finality                │
│     synchronizeWithChain() confirms on-chain                │
└─────────────────────────┬───────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│  6. Commit: Replace master with working grid                │
│     this.orders = Object.freeze(workingGrid.toMap())        │
└─────────────────────────────────────────────────────────────┘
```

### Triggers for Master Grid Updates

Only blockchain-confirmed events trigger master updates:

| Event | Entry Point | Mechanism |
|-------|-------------|-----------|
| Order Created | `sync_engine.ts` `synchronizeWithChain()` | Called with `source: 'createOrder'` |
| Order Cancelled | `sync_engine.ts` `synchronizeWithChain()` | Called with `source: 'cancelOrder'` |
| Order Filled | `sync_engine.ts` `syncFromFillHistory()` | Processes a real-time fill event |
| Full Sync | `sync_engine.ts` `syncFromOpenOrders()` | Reconciles grid against current open orders |
| Grid Init/Load | `grid.ts` `createOrderGrid()` | Bootstrap operations |

### Defensive Measures

1. **Double-check commit pattern**: Staleness is checked both outside and inside the lock
2. **Working grid sync**: If master mutates during planning, working grid is marked stale
3. **Version mismatch detection**: Commits abort if `baseVersion` doesn't match `_gridVersion`

---

## Fill Processing Pipeline

The fill pipeline handles incoming filled orders efficiently through fixed-cap batching instead of one-at-a-time processing.

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                   Fill Event (Blockchain)                   │
│                  (Order filled at price X)                  │
└─────────────────────┬───────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────────────┐
│               _incomingFillQueue (FIFO Queue)               │
│             (Accumulates fills from blockchain)             │
│       Queue: [fill1, fill2, fill3, fill4, fill5, ...]       │
└─────────────────────┬───────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────────────┐
│             processFilledOrders() - Entry Point             │
│    Use gap-slot batch size (gapSlots+1) for deterministic batching   │
│      Rules: <=gapSlots+1 unified, >gapSlots+1 chunked      │
└─────────────────────┬───────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────────────┐
│            Pop Batch (up to gapSlots+1)                     │
│        Takes N fills from queue head (N = 1..gapSlots+1)     │
│   Example: pops [fill1, fill2, fill3] for batch processing  │
└─────────────────────┬───────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────────────┐
│            processFillAccounting() - Single Call            │
│       All fills credited to chainFree in ONE operation      │
│     chainFree += proceeds[fill1] + proceeds[fill2] + ...    │
│    Proceeds immediately available (same rebalance cycle)    │
└─────────────────────┬───────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────────────┐
│             calculateTargetGrid() - Single Call             │
│       Size replacement orders using combined proceeds       │
│             Apply rotations and boundary shifts             │
│ Use unallocated remainder for next allocation opportunities │
└─────────────────────┬───────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────────────┐
│        updateOrdersOnChainBatch() - Single Broadcast        │
│      All new orders + cancellations in single operation     │
│          Result: Atomic state update on blockchain          │
└─────────────────────┬───────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────────────┐
│                        persistGrid()                        │
│               Save grid state to disk/storage               │
└─────────────────────┬───────────────────────────────────────┘
                      ↓
                  Loop to next batch
                (or idle if queue empty)
```

### Key Properties

- **Gap-Slot Batch Sizing**: Batch size is deterministic, derived from the grid gap-slot count + 1 (`DEXBot._getGapSlotBatchSize`)
  - 1..gapSlots+1 awaiting: single unified batch (one rebalance/broadcast cycle)
  - more than gapSlots+1 awaiting: repeated chunks of gapSlots+1 (last chunk may be smaller)

- **Single Rebalance Cycle**: All fills in batch processed in ONE rebalance
  - No "split across cycles" delays
  - Combined proceeds immediately available
  - Single cache fund update

- **Recovery Retries**: Periodic retry system replaces one-shot flag
  - Max 5 attempts per episode
  - 60s minimum interval between retries
  - Reset on fill arrival or periodic sync (10 minutes)
  - `resetRecoveryState()` called by Accountant

- **Stale-Cleaned Order Tracking**: Prevents orphan double-credit
  - Batch failure → cleanup stale order IDs
  - Delayed orphan event → check if ID in stale-cleaned map
  - Skip credit if already cleaned
  - TTL pruning (5 minute retention)

### Impact vs. Legacy Sequential Processing

Scenario source: 29-fill burst during the Feb 7 market crash, modeled at
roughly 3 seconds per broadcast; see
[`FUND_MOVEMENT_AND_ACCOUNTING.md`](FUND_MOVEMENT_AND_ACCOUNTING.md#15-fill-batch-processing--timeline).

| Metric | Legacy (1-at-a-time) | Fixed-Cap Batching | Improvement |
|--------|---------------------|-------------------|-------------|
| **29 Fills** | ~90 seconds | ~24 seconds | **73% faster** |
| **Market Divergence** | High (90s window) | Low (24s window) | **Safer** |
| **Stale Orders** | Frequent | Rare | **More reliable** |
| **Recovery** | One-shot (brick) | Periodic (self-heal) | **Production-ready** |

---

## Spread Correction (Fund-Aware Approach)

Simplified spread maintenance that keeps the gap consistent and fund-driven, avoiding complex split/merge mechanics.

### The Approach

Instead of complex partial handling, spread corrections are **conservative and fund-safe**:
- Target spread width stays **constant** at `targetSpreadPercent`
- Corrections scale with **actual available funds**, not arbitrary slot budgets
- No dynamic spread inflation based on partial consolidation flags
- Safe window-contiguous candidate ordering (with an edge-first fallback) prevents cross-side placement

### Algorithm

**Location**: `modules/order/grid.ts::prepareSpreadCorrectionOrders()`, selected by
`modules/order/grid.ts::determineOrderSideByFunds()`.

The correction path is fund-only and never manufactures budget by shrinking a resting order:

```
1. Detect that the live window is wider than targetSpreadPercent.
2. Select up to `outOfSpread` spread-tightening empty slots (below the lowest
   live sell / above the highest live buy), ordered window-contiguous first, with
   a market-nearest fallback when the rail has no live order.
3. Create those slots from free available/chainFree funds only. A resting PARTIAL
   is never a correction target: a top-up grows an order at its current price, so
   it cannot move bestBuy/bestSell and cannot narrow the spread.
4. Contiguous gap-slot promotion may extend the window while preserving
   MIN_SPREAD_ORDERS and the opposite placed rail.
5. If free funds cannot cover every target, place the affordable prefix, then
   **rotate a resting same-side order** into each unfunded promoted gap slot
   (same booked size, never a new commitment). A fully allocated rail has ~0
   free forever, so create-only repair can never close the spread; the rotation
   is the repair path and is bounded by the same promotion, crossing, last-fill,
   dedupe/duplicate-price and edge-order guards as a create. It never shrinks or
   grows the moved order. Exactly-zero free on both sides is covered by a
   rotation-only fallback around side selection (an unavailable market price is
   still a hard skip: cross-asset comparison is unsafe).
6. If neither side places an effective order, `checkSpreadCondition` reports a
   `stall` cause (`no-free-funds` / `unfunded` / `no-candidates` / `cold-book` /
   `unmatched-orders` / `readiness-gate` / `last-fill-blocked` /
   `batch-not-executed` / `apply-error`). `last-fill-blocked` is the geometry
   bind: every tightening slot on that side is at/through the last fill, so a
   sell slot below the last sale means the boundary/crawl is behind the fill —
   placement cannot repair it and the re-center can, so it escalates on the
   short geometry window (at most once per fill pivot: a re-center does not move
   the pivot, so a repeat attempt would only churn the new generation).
   Every cause arms the targeted
   balances + open-orders refresh: the local snapshot the check reasoned over
   may be stale (`no-candidates` can mean a missed fill left an ACTIVE slot
   occupying the window edge, so no tightening slot appears to exist), and only
   a chain sync can tell a stale snapshot from structural geometry. The
   out-of-spread staleness watchdog remains the backstop if the sync heals
   nothing. No resting order is ever recycled.
```

Detected dust partials never enter this path: `cancelDustOrders()` cancels them
on-chain immediately, and the five-minute health check is only a restart safety net.

### Fund-Safe Constraints

Spread corrections respect these hard limits:

```javascript
// In modules/constants.ts (GRID_LIMITS)
MIN_SPREAD_ORDERS: 2,           // Preserve the minimum empty gap reserve

// `outOfSpread` supplies the requested slot count. Execution is bounded by
// safe candidate selection, healthy minimum sizes, and actual free funds.
const availableFund = Math.max(0, Math.min(
    manager.funds.available[side],
    manager.accountTotals[side === 'buy' ? 'buyFree' : 'sellFree']
));

// Each target is created only while remainingBudget covers it.
// If the budget cannot fund a promoted gap slot, a resting same-side ACTIVE
// order is rotated into that slot at its booked size (no new commitment).
// No resting ACTIVE/PARTIAL order is shrunk or grown to fund the correction.
```

`availableFund` is `chainFree − virtualReservation`, so it reads 0 when the
empty rail already reserves more than the chain holds. That state
(*rail oversubscribed*) is named explicitly in the log and flagged on the
manager; the out-of-spread watchdog then escalates on its short fund window
instead of waiting for a fill that cannot free existing inventory.

The budget the loop spends is **not** `availableFund`, because subtracting the
projection from the budget that funds that same projection is circular: a rail
sized from a larger balance (or from inventory locked in resting orders) reads 0
forever and no placement can ever shrink it. `deriveChainTruthFundBudget`
(`order/utils/math.ts`) re-derives it for a known candidate set:

```text
budget = availableFund > 0            ? availableFund   // healthy: accounting wins
       : virtualReservation > chainFree ? min(chainFree, min(virtualReservation, Σ candidate ideals))
       : availableFund                                 // zero for fees/empty balance: honour it
```

so the correction funds what the chain actually holds free (capped by what the
candidates need, and the chain stays the final arbiter). Live effect: the
`planned 3, placing 0` cycle that ran for 84 minutes now places the three holes.

### Owed Fill Crawls: consume what was applied, keep the rest owed

Every shift-eligible fill records a relative boundary delta (`_pendingFillCrawls`)
because the batch that saw the fill may not commit a boundary (refused
broadcast, held boundary, restart). The derivation folds a *subset* — current-batch
slots are deduped (their shift comes from `fills`), edge slots never crawl, and
the cross-chunk budget caps how far one plan may move. So the commit must not
clear the whole ledger: `deriveTargetBoundary` returns `consumedCrawlIds`
(what it applied, plus what it deliberately never counts), the plan carries it
to `_consumePendingFillCrawls` via `buildSuccessResult` → `CowResult` →
`_commitWorkingGrid({ consumedCrawlIds })`, and only those records are dropped.
A capped fold consumes a same-side prefix up to the applied magnitude; the rest
stays owed and applies exactly once on a later derivation. `_clearPendingFillCrawls`
is the explicit allowed-loss path (rebuild, rejected snapshot, restart replay).

### Boundary Re-Anchoring: the fill is the anchor

A boundary crawl is ±1 slot per committed fill, so a window that ends up
**behind** the newest real fill cannot catch up by crawling — every tightening
slot on that side is then at/through the fill and `passesLastFill` refuses all of
them while the funds sit in the resting (stranded) inventory. `reanchorBoundaryFromLastFill`
(`order/utils/system.ts`, called from `calculateTargetGrid` right after the
derivation) treats the fill as the anchor:

```text
SELL fill at slot f  ->  boundary >= f - gapSlots     (sellStart = f + 1)
BUY  fill at slot f  ->  boundary <= f - 1            (buy window ends below f)
```

Preconditions, all fail-closed: a real fill-provenanced pivot (`lastFillPivotSource`
must be `fill`; a book-seeded max-bid/min-ask heuristic never anchors, and the
bot-scoped last-market-fill row is the fallback), an on-ladder price within one
increment (`off-ladder-fill`), a target that actually puts the fill outside the
window after the grid-ceiling clamp (`ceiling-clamped`), and the candidate must
pass `validatePersistedBoundary` — the SAME gate the restore and commit paths
use (`validatePersistedBoundary` is the disk-trust wrapper over
`validateBoundaryCommit`: in-band placement rejection plus an optional
allow-list), so every boundary writer ends in one validator.

**Eligibility is the crawl's eligibility.** EDGE-pinned insurance fills never
arm the pivot (`recordLastFilledPrices` skips them via
`collectEdgePinnedFillIds`) and therefore never anchor: an edge order is static
fat-finger insurance, not market movement, and an absolute anchor from a
rail-edge price would teleport the window to that edge (observed: boundary 29 →
0 after a floor insurance BUY filled on a 60-slot ladder). PARTIAL fills DO
anchor — a partial at a far slot is still a real trade, and its residual is the
allow-listed case below.

A live order inside the re-typed band still refuses the re-anchor
(`unsafe: placed_order_in_band`) with one deliberate exception: the fill's
**own PARTIAL residual** at the anchor slot (same side, same ladder level) is
allow-listed, because any boundary that puts the fill outside its window
necessarily puts that remainder inside the band. A partial fill therefore no
longer deadlocks the geometry; GAP-EVAC cleans the residual afterwards.
Because that remainder is persisted in-band, the startup and recovery load
paths pass `tolerateTransientStranding` and keep the boundary
(warn + load) instead of rebuilding it away. Every accepted re-anchor is logged
at warn with the fill slot, the pivot price and the boundary move.

The re-anchor is an **absolute** anchor. Its accepted result subsumes every
pending crawl snapshot taken at plan time (`consumedCrawlIds` is replaced with
the whole snapshot in `calculateTargetGrid`), otherwise a later derivation could
apply those older deltas on top of the re-anchored boundary. Records recorded
after plan-build are not in the snapshot and stay owed for the next cycle.

The anchor slot is the current fill batch's **extremum** for that side (max slot
for SELL, min slot for BUY), resolved from each fill's real execution price with
the slot id only as a legacy fallback. The guard pivot is the *last-processed*
fill, which a chunked sweep overwrites per chunk (live: 1366 → 1349 → 1361);
anchoring on it leaves the furthest fill's counter order inside the implied
band. `calculateTargetGrid` passes the batch into
`reanchorBoundaryFromLastFill`.

### Rail-Derived Commit Boundary (counter orders are the fact)

A plan built at a re-anchored boundary places **counter orders** on the promoted
rail (`SELL fill at s => counter BUY at s - gapSlots`). If the refill hold then
keeps the old committed boundary because the opposite-side refills were
guard-skipped, those counters are reclassified as in-band and the next plan
places sells on top of them (live 2026‑10‑30: counters at 1329.7–1345.7 were
held behind boundary 133, then sells were rotated onto 1345.728664 — the exact
price of the buy that had just filled; visible spread 1.5% → 0.3%).

`deriveRailBoundary` (`dexbot_cow_runtime.ts`, pre-broadcast) therefore clamps
the boundary to the batch's resulting rails — the batch's own op destinations
plus the master rail orders that sit on their own side of the planned boundary
(a BUY at/below it, a SELL at/above the implied sellStart):

```text
maxBuyIdx <= boundary <= minSellIdx - gapSlots - 1
```

Counter orders win over empty refill holes. When the batch placed nothing above
the committed boundary, the clamp is a no-op and the refill hold is unchanged.

**Strays do not clamp, and rail indices come from the live price.** A master
rail order parked on the wrong side of the planned boundary is a *stray* — a
refused-commit adoption at an old generation level, a SPREAD-GUARD straggler, a
stranded hold — and is skipped (counted in the log line), because letting it
clamp would SELF-LEGALIZE the corrupt state (live class: one live sell 18 slots
below clamped the boundary 138 → 115 and re-typed the whole window). Its rail
index is the order's LIVE chain price mapped onto the ladder
(`resolveLiveOrderLadderPosition`), not the slot id, for the same reason the
fill/gap/crossing paths are live-price: a stale slot id misplaces the order.

A crossed or over-ceiling rail fails closed (`rail-crossed` /
`rail-exceeds-grid`): keep the previous boundary, never legalize the overlap;
GAP-EVAC / the next plan owns the offending order. The result is then passed
through the shared `validatePersistedBoundary` gate (skipped only for a sparse
ladder, whose array-length ceiling would reject everything), with the slots the
batch cancels or rotates away allow-listed — so the rail clamp and the re-anchor
cannot disagree about what "stranded in the band" means.

### Live-Price Provenance (fill, gap, crossing)

A refused-commit adoption can leave a master slot keyed at an old generation
price while its chain order rests elsewhere (slot-118 @1267 vs a trade at
1345.73). The grid slot keeps that identity price (`GRID-PRICE-INVARIANT`); the
**transient decisions** use the live chain price:

- fill records pin the execution price from paid/received amounts (or the chain
  order price), so the last-fill pivot and the re-anchor judge the real market;
- gap-evacuation geometry maps the live price onto the ladder
  (`resolveLiveOrderLadderPosition`) before falling back to the slot index, and
  a price mismatch whose live price is in-band queues a cancel-only evacuation
  ahead of any plain re-price;
- the crossing-guard candidate set uses the live price, so an emission cannot
  print onto a live opposite-side order that was adopted at a stale slot price.

### Candidate Selection: Spread Edge, Grid Slot, Last-Fill Consistent

The planner only ever emits the tightening edge on a real grid slot:

- `tightensSpread` — a SELL must improve (be below) the lowest live sell, a BUY
  must improve the highest live buy;
- `sortCandidates` + `.slice(0, missingSlots)` — the nearest empty level to the
  live edge, so no interior hole is created;
- `doesNotCrossMarket` — the absolute crossing floor (fresh live read, fill
  reference as fallback);
- **`passesLastFill`** — the same direction rule the broadcast guard applies
  (`SELL` above the last fill, `BUY` below it), evaluated on the same pivot.

The last filter is what keeps planner and guard from disagreeing: without it a
cycle could plan a candidate the guard was guaranteed to drop, and the whole
batch would be reported as "prepared but not executed" (observed live: the only
funded candidate sat at the fill price, both attempts were dropped, and the
correction spent its cycle on a refusal). With it, an unplaceable side reports
*no placeable slot — every tightening slot is at/through the last fill* and the
batch is never built. Only a fill arriving **during** the check can still change
the pivot under the batch; the final pre-broadcast gate remains the last line
for that race.

**Benefits**:
- ✅ No inventory recycling from stale-size snapshots
- ✅ Constant, predictable spread width
- ✅ Funds always respected (no forced allocation)
- ✅ Natural smoothing over multiple rebalance cycles

### Resilience: Atomic Broadcast, Plan-Time Dedupe, Bounded Re-Plan

A correction is planned under `_gridLock` but broadcast *after* the lock is
released, so a concurrent fill rebalance can invalidate it in that window. Left
alone, the batch is refused fail-closed and the grid waits for a fill it cannot
produce (an out-of-spread grid generates no fill) — the stale-grid pathology.
`checkSpreadCondition` wraps the plan/broadcast in a bounded, region-held
attempt loop so a stale plan heals in place:

1. **Region hold (atomicity).** The refcounted broadcast region
   (`startBroadcasting` / `stopBroadcasting`, released in `finally`) is held for
   the whole attempt loop, so a fill rebalance defers instead of committing a
   master-version bump between the plan and its broadcast. This narrows the
   race; the COW commit guard remains the backstop.
2. **Plan-time CREATE dedupe.** Before broadcasting, `getOccupiedCorrectionSlots`
   checks whether a planned destination became a live order since planning, and
   `resolveOccupiedCorrection` re-derives from fresh master or withholds the
   colliding batch. A known-taken slot is never shipped (the COW build layer is
   still authoritative against a false positive).
3. **Bounded fresh-master re-plan.** On a **transient** refusal (stale plan /
   duplicate CREATE / unclassified non-execution) the cycle re-plans once from
   fresh master (`replanSpreadCorrectionFromFreshMaster`) and retries —
   `TIMING.SPREAD_CORRECTION_MAX_ATTEMPTS` (default 2 = initial + one retry).
   A **non-transient** refusal (commit-refused, update-target-missing, unmatched
   chain orders, shutdown) is not retried and counts toward grid staleness.
4. **Observability.** `spreadCorrectionRefusedCount`, per-cause
   `spreadCorrectionRefusalCauses` (vocabulary `SPREAD_CORRECTION_REFUSAL`), and
   `spreadCorrectionRetryCount`, surfaced through `getMetrics()` and the shutdown
   line separately from the generic `refusedCommitCount`.

**Retry invariant:** an `uncertain: true` COW result is retry-safe only while the
COW layer adopts-or-defers-with-guard into master before returning. The
adopt/discard path persists first; the ambiguous-read path keeps pending-broadcast
protection (the existing orderId build guard is the fail-safe, not fail-fast).

### Out-of-Spread Watchdog

Independent of the in-cycle retry, the maintenance watchdog (`trackOutOfSpreadStaleness`)
tracks how long the grid has been continuously out of tolerance **without an
effective correction**:

- warns once past `TIMING.SPREAD_STALE_WARN_MS`;
- escalates to a structural re-center past `TIMING.SPREAD_STALE_ESCALATE_MS`
  (cooldown `TIMING.SPREAD_STALE_RESYNC_COOLDOWN_MS`);
- clears the clock only after the spread has stayed in tolerance for
  `TIMING.SPREAD_STALE_IN_TOLERANCE_RESET_MS` (or immediately on a placed
  correction). A single in-tolerance reading does not clear it: the measured
  spread oscillates around the tolerance edge, and resetting per good glance let
  a live bot sit out of tolerance for 84 minutes while every cycle looked
  recoverable;
- escalates on a **shorter** window (`TIMING.SPREAD_STALE_FUND_ESCALATE_MS`) when
  the correction reports a rail-oversubscribed fund stall (`virtual` reservation
  > chain free on the corrected side). That state cannot heal by waiting for a
  fill — the rail must be re-sized from chain truth, which the re-center does;
- tolerates up to `TIMING.SPREAD_STALE_TRANSIENT_GRACE` consecutive **transient**
  refusals (which reset the stale clock) before they count toward escalation, so a
  retryable refusal is not mistaken for a structural dead end — a persistent one
  still re-centers.

These spread knobs (with `SPREAD_CORRECTION_SYNC_FRESH_MS`) are global `TIMING`
keys, overridable under `TIMING` in `profiles/general.settings.json`; they are not
per-bot settings.

---

## Periodic Market Price Refresh

Background market price updates every 4 hours to ensure grid anchoring remains accurate during long-running sessions without fills.

### Purpose

If the bot hasn't seen fills for 4 hours, the `startPrice` might become stale if:
- Market has drifted significantly
- Liquidity pool price has shifted
- User wants grid recalculation

### Configuration

**Location**: `modules/constants.ts`

```javascript
BLOCKCHAIN_FETCH_INTERVAL_MIN: 240,  // 4 hours = 240 minutes
```

### Implementation Flow

**1. Interval startup** — `setupBlockchainFetchInterval()` in
`modules/dexbot_maintenance_runtime.ts` starts the interval during bot initialization:

```javascript
bot._blockchainFetchInterval = setInterval(tick, BLOCKCHAIN_FETCH_INTERVAL_MIN * 60 * 1000);
```

**2. Tick guards** *(no lock held)*
- Skip if shutdown has begun or a previous tick is still in flight
- Sync market adapter watchdog config

**3. Periodic work** *(under the fill-processing lock)*
- Reset accountant recovery state
- Refresh dynamic weight distribution
- `fetchAccountTotals(accountId)` — refreshes balances and the valuation anchor
- Read open orders via guarded read — truncated/empty reads defer the sync; fills are still caught by subscriptions and the next cycle
- `synchronizeWithChain(...)` — re-aligns the grid with on-chain reality; detected fills run through the normal batched rebalance pipeline and the grid is persisted, unmatched chain orders log as surplus/divergence
- `performPeriodicGridChecks(bot)` — maintenance checks (see [Lifecycle](LIFECYCLE.md))

Grid placement remains fund-driven during normal operation; the periodic tick keeps
balances, valuations, and open-order state fresh rather than directly moving prices.
A per-instance override (`_blockchainFetchIntervalMin`, e.g. for shared accounts from
the fund registry) can shorten or lengthen the interval; setting a non-positive value
disables the loop entirely.

### When `startPrice` is Numeric

If user set `startPrice: 105.5` in bots.json:
- **No auto-refresh**: Numeric value is treated as fixed anchor
- **Valuation uses fixed value**: All calculations use 105.5
- **Grid doesn't move**: Orders stay where they are (fund-driven rebalancing only)

### Non-Disruptive Updates

Price refresh is passive:
- ✅ Updates internal valuation
- ✅ Affects future grid resets if triggered
- ❌ Does NOT move orders on blockchain (no funds wasted on unnecessary rotations)

---

## Out-of-Spread Metric Refinement

Refactored `outOfSpread` from a simple boolean flag to a numeric distance metric for more precise structural updates.

### Before (Boolean)

```javascript
// Old approach
mgr.outOfSpread = true;  // Binary: either in or out
if (mgr.outOfSpread) {
    // Perform spread correction
}
```

**Problem**: Doesn't distinguish between "slightly out" vs "severely out"

### After (Numeric Distance)

```javascript
// New approach: requested missing slots derived from the live geometry
mgr.outOfSpread = 3;  // three slots beyond the target spread

// The grid engine bounds actual work by eligible candidates, MIN_SPREAD_ORDERS,
// healthy sizes, and available free funds. There is no MAX_CORRECTION_SLOTS cap.
```

**Benefit**: Enables scaled corrections based on actual severity.

### Calculation

```javascript
// Requested extra slots, derived from the live spread vs the target tolerance:
// calculateCurrentSpread(mgr) -> shouldFlagOutOfSpread(...) returns the slot count.
mgr.outOfSpread = shouldFlagOutOfSpread(
    calculateCurrentSpread(mgr), nominalSpread, toleranceSteps, buyCount, sellCount, incrementPercent
);
// 0 = in spread, 3+ = out
```

---

## Pipeline Safety & Diagnostics

The bot includes a comprehensive pipeline monitoring system to prevent indefinite blocking and enable operational visibility.

### Pipeline Timeout Safeguard

**Problem**: Pipeline checks could block indefinitely if operations hung due to network issues or stuck corrections.

**Solution**: 5-minute timeout with automatic, non-destructive recovery.

**Configuration** (modules/constants.ts):
```javascript
PIPELINE_TIMING: {
    TIMEOUT_MS: 300000,  // 5 minutes
}
```

**How It Works**:
- `isPipelineEmpty()` tracks when pipeline operations started blocking via `_pipelineBlockedSince` timestamp
- If blockage exceeds 5 minutes, `clearStalePipelineOperations()` is called
- Non-destructive recovery: clears operation flags only, does NOT delete orders or modify grid state
- Recovery called from `_executeMaintenanceLogic()` during periodic maintenance checks

**Location**: `modules/order/manager.ts` (`isPipelineEmpty()` and `clearStalePipelineOperations()`)

### Data Flow

```mermaid
sequenceDiagram
    participant Bot as DexBotClass
    participant Mgr as OrderManager
    participant Sync as SyncEngine
    participant Strat as StrategyEngine
    participant Acct as Accountant
    participant Chain as Blockchain

    Bot->>Mgr: Initialize grid
    Mgr->>Acct: Reset funds
    Mgr->>Sync: Fetch account balances
    Sync->>Chain: Get balances
    Chain-->>Sync: Balance data
    Sync->>Acct: Set account totals
    Acct->>Acct: Recalculate funds

    Note over Mgr: Grid initialized, ready for trading

    Bot->>Sync: Detect fills (polling)
    Sync->>Chain: Get open orders
    Chain-->>Sync: Order data
    Sync->>Mgr: syncFromOpenOrders()
    Mgr->>Mgr: processFilledOrders()
    Strat->>Acct: Update funds (cache proceeds)
    Strat->>Strat: Identify shortages/surpluses
    Strat->>Mgr: Rotate orders
    Mgr->>Acct: Deduct funds (atomic)
    Mgr->>Chain: Place new orders
```

---

## Order State Machine

Orders transition through three primary **states** during their lifecycle. **SPREAD** is an *order type* (like BUY or SELL), not a state — spread-zone slots always carry `state: VIRTUAL`.

```mermaid
stateDiagram-v2
    [*] --> VIRTUAL: Grid created

    VIRTUAL --> ACTIVE: Order placed on-chain
    VIRTUAL --> VIRTUAL: Rotated or rebuilt

    ACTIVE --> PARTIAL: Partial fill detected
    ACTIVE --> VIRTUAL: Order cancelled/rotated

    PARTIAL --> ACTIVE: Consolidated (size >= ideal)
    PARTIAL --> VIRTUAL: Moved/consolidated

    VIRTUAL --> [*]: Grid regenerated

    note right of VIRTUAL
        No on-chain presence
        Funds reserved in virtual pool
        Includes spread-zone placeholders
    end note

    note right of ACTIVE
        On-chain with orderId
        Funds locked/committed
    end note

    note right of PARTIAL
        Partially filled on-chain
        Dust is cancelled immediately; non-dust is corrected in rebalance
    end note
```

### State Transition Rules

| From State | To State | Trigger | Fund Impact |
|------------|----------|---------|-------------|
| VIRTUAL | ACTIVE | Order placed | Deduct from `chainFree` |
| ACTIVE | PARTIAL | Partial fill | Reduce `committed` by filled amount |
| ACTIVE | VIRTUAL | Order cancelled | Add back to `chainFree` |
| PARTIAL | ACTIVE | Consolidation | Update to `idealSize` (consumes available funds) |
| PARTIAL | VIRTUAL | Order moved | Release funds, re-reserve |

### Critical: Phantom Order Prevention

A **phantom order** is an illegal state where an order exists as ACTIVE/PARTIAL without a corresponding blockchain `orderId`. This corrupts fund tracking and causes "doubled funds" warnings.

**Risks the Three-Layer Defense Guards Against**:
1. **Resize State Forcing**: Grid resize forcing VIRTUAL → ACTIVE without blockchain confirmation
2. **Sync Gaps**: Orders without `orderId` remaining ACTIVE if sync logic skips them
3. **Unvalidated Assignment**: Invalid state assignments without a centralized check

**Prevention System** (Three-Layer Defense):

| Layer | Location | Mechanism |
|-------|----------|-----------|
| **Guard** | `manager.ts::_updateOrder()` | Centralized validation in `_updateOrder()` rejects ACTIVE/PARTIAL without orderId, auto-downgrades to VIRTUAL |
| **Grid Protection** | `grid.ts` | Preserve order state during resize: `state: order.state` instead of forcing ACTIVE |
| **Sync Cleanup** | `sync_engine.ts` | Detect orders without orderId and convert to SPREAD placeholders; prevent phantom fills from triggering rebalancing |

**Verification**:
- Direct state assignment in code review: All transitions go through `_updateOrder()` (cannot bypass)
- Automated tests: `tests/repro_phantom_orders.ts` confirms all prevention layers work
- Logging: Any phantom creation attempt is logged as ERROR with context

---

## Fund Flow Architecture

The fund tracking system uses atomic operations to prevent race conditions and overdrafts.

```mermaid
graph LR
    subgraph "Blockchain Balances"
        CHAIN_FREE[chainFree<br/>Unallocated funds]
        CHAIN_COMMITTED[committed.chain<br/>On-chain orders]
    end

    subgraph "Internal Tracking"
        VIRTUAL[virtual<br/>Reserved for VIRTUAL orders]
        GRID_COMMITTED[committed.grid<br/>ACTIVE order sizes]
    end

    subgraph "Calculated Values"
        AVAILABLE[available<br/>= chainFree - virtual<br/>- fees]
        TOTAL_CHAIN[total.chain<br/>= chainFree + committed.chain]
        TOTAL_GRID[total.grid<br/>= committed.grid + virtual]
    end

    CHAIN_FREE --> AVAILABLE
    VIRTUAL --> AVAILABLE

    CHAIN_FREE --> TOTAL_CHAIN
    CHAIN_COMMITTED --> TOTAL_CHAIN

    GRID_COMMITTED --> TOTAL_GRID
    VIRTUAL --> TOTAL_GRID

    style AVAILABLE fill:#90EE90
    style VIRTUAL fill:#87CEEB
```

### Fund Components Explained

- **chainFree**: Unallocated funds on blockchain (from `accountTotals.buyFree/sellFree`)
- **committed.chain**: Funds locked in on-chain orders (ACTIVE orders with `orderId`)
- **committed.grid**: Internal tracking of ACTIVE order sizes
- **virtual**: Funds reserved for VIRTUAL orders (not yet on-chain)
- **available**: Free funds for new orders = `max(0, chainFree - virtual - fees)`

### Atomic Fund Operations

```mermaid
sequenceDiagram
    participant Strat as StrategyEngine
    participant Mgr as OrderManager
    participant Acct as Accountant

    Note over Mgr: Want to place order<br/>size = 100

    Mgr->>Acct: tryDeductFromChainFree(type, 100)

    alt Sufficient funds (available >= 100)
        Acct->>Acct: chainFree -= 100
        Acct->>Acct: virtual += 100
        Acct-->>Mgr: true (success)
        Mgr->>Mgr: Place order
    else Insufficient funds
        Acct-->>Mgr: false (failed)
        Note over Mgr: Order not placed<br/>No fund leak
    end
```

---

## Grid Topology

The grid uses a unified "Master Rail" with a dynamic boundary that shifts as fills occur.

```mermaid
graph LR
    subgraph "Master Rail (Price Levels)"
        direction LR
        B0[buy-0<br/>VIRTUAL]
        B1[buy-1<br/>ACTIVE]
        B2[buy-2<br/>ACTIVE]
        BOUNDARY{Boundary<br/>Index}
        S0[spread-0<br/>SPREAD]
        S1[spread-1<br/>SPREAD]
        S2[spread-2<br/>SPREAD]
        SELL0[sell-173<br/>ACTIVE]
        SELL1[sell-174<br/>ACTIVE]
        SELL2[sell-175<br/>VIRTUAL]
    end

    B0 --> B1 --> B2 --> BOUNDARY
    BOUNDARY --> S0 --> S1 --> S2
    S2 --> SELL0 --> SELL1 --> SELL2

    style B1 fill:#90EE90
    style B2 fill:#90EE90
    style S0 fill:#FFD700
    style S1 fill:#FFD700
    style S2 fill:#FFD700
    style SELL0 fill:#FF6B6B
    style SELL1 fill:#FF6B6B
    style BOUNDARY fill:#87CEEB
```

### Boundary Movement

- **Buy Fill**: `boundaryIdx -= 1` (shift left/down)
- **Sell Fill**: `boundaryIdx += 1` (shift right/up)

### Role Assignment

- **BUY**: Slots `[0, boundaryIdx]`
- **SPREAD**: Slots `[boundaryIdx + 1, boundaryIdx + G]` where G = spread gap size (empty slots). Actual gaps = G + 1.
- **SELL**: Slots `[boundaryIdx + G + 1, N]`

---

## Key Operations

### 1. Fill Processing Flow

```mermaid
sequenceDiagram
    participant Chain as Blockchain
    participant Sync as SyncEngine
    participant Mgr as OrderManager
    participant Acct as Accountant
    participant Strat as StrategyEngine

    Chain->>Mgr: Order filled
    Mgr->>Mgr: Detect fill
    Mgr->>Strat: processFillsOnly([fills])

    Strat->>Acct: Add proceeds to chainFree

    Mgr->>Strat: calculateTargetGrid(params)
    Strat-->>Mgr: target grid
    Mgr->>Mgr: Apply rotations via WorkingGrid
    Mgr->>Acct: Deduct BTS fees during recalculateFunds
    Mgr->>Mgr: Cancel detected dust partials immediately
```

### 2. Order Rotation (Crawl Mechanism)

```mermaid
graph TB
    START[Fill Detected] --> SHIFT[Shift Boundary]
    SHIFT --> IDENTIFY[Identify Shortages<br/>Empty slots in active window]
    IDENTIFY --> CHECK{Surpluses<br/>Available?}

    CHECK -->|Yes| CRAWL[Select Crawl Candidate<br/>Furthest active order]
    CHECK -->|No| NEW[Place New Order<br/>if funds available]

    CRAWL --> COMPARE{Shortage price<br/>better than<br/>surplus price?}
    COMPARE -->|Yes| ROTATE[Rotate Order<br/>Cancel old, place new]
    COMPARE -->|No| SKIP[Skip rotation]

    ROTATE --> NEXT{More<br/>shortages?}
    SKIP --> NEXT
    NEW --> NEXT

    NEXT -->|Yes| IDENTIFY
    NEXT -->|No| DONE[Rebalance Complete]
```

### 3. Grid Divergence Detection

The grid divergence system monitors and corrects misalignment between ideal grid state and persistent blockchain state.

```mermaid
graph TB
    START[Grid Update Triggered] --> CALC[Calculate Ideal Grid<br/>Based on current funds]
    CALC --> RELOAD[Force Reload Persisted Grid<br/>Ensure fresh blockchain state]
    RELOAD --> COMPARE[Compare to Persisted Grid]
    COMPARE --> RMS[Calculate RMS Divergence<br/>ACTIVE + VIRTUAL orders per side]

    RMS --> CHECK{RMS > Threshold?}
    CHECK -->|Yes| UPDATE[Update Grid Sizes<br/>Trigger rebalance]
    CHECK -->|No| SKIP[Skip update]

    UPDATE --> PERSIST[Persist New Grid State]
    PERSIST --> DONE[Complete]
    SKIP --> DONE
```

The force reload mechanism loads fresh persisted grid data before comparison, preventing stale cache from causing false divergence detections.

---

## Concurrency & Locking

The system uses order-level locks to prevent race conditions during async operations. For the reconciler-specific lock hierarchy and the historical `_syncLock`/`_gridLock` swap, see [GRID_RECONCILE.md](GRID_RECONCILE.md#lock-hierarchy).

### Lock Mechanism

```mermaid
sequenceDiagram
    participant Sync as SyncEngine
    participant Strat as StrategyEngine
    participant Mgr as OrderManager

    Note over Sync: Detected fill on order P1
    Sync->>Mgr: lockOrders([P1])
    Sync->>Sync: Process fill

    par Concurrent Strategy Check
        Strat->>Mgr: isOrderLocked(P1)?
        Mgr-->>Strat: true
        Note over Strat: Skip P1 (locked)
    end

    Sync->>Sync: Complete fill processing
    Sync->>Mgr: unlockOrders([P1])

    Note over Strat: Next cycle can now process P1
```

### Lock Lifetime

- **Default timeout**: 5-10 seconds
- **Auto-expiry**: Prevents deadlocks from crashes
- **Best practice**: Always use try/finally to ensure unlock

---

## Module Responsibilities Summary

| Module | Primary Responsibility | Key Functions |
|--------|----------------------|---------------|
| **OrderManager** | Central coordinator, state management | `_updateOrder()`, `lockOrders()`, `getOrdersByTypeAndState()` |
| **Accountant** | Fund tracking, fee management | `recalculateFunds()`, `tryDeductFromChainFree()`, `_verifyFundInvariants()` |
| **StrategyEngine** | Grid rebalancing, rotation target calculation | `calculateTargetGrid()`, `processFillsOnly()`, `hasAnyDust()` |
| **SyncEngine** | Blockchain sync, fill detection | `syncFromOpenOrders()`, `synchronizeWithChain()` |
| **Grid** | Grid creation, sizing, divergence | `createOrderGrid()`, `compareGrids()`, `checkAndUpdateGridIfNeeded()` |
| **Utils** | Shared utilities, conversions | `quantizeFloat()`, `normalizeInt()` (`math.ts`); order predicates (`order.ts`); COW action building (`validate.ts`); price derivation (`system.ts`) |
| **Logger** | Formatted logging, diagnostics | `logOrderGrid()`, `logFundsStatus()` |

---

## Dynamic Configuration Refresh

The bot implementation supports runtime updates to specific configuration parameters without requiring a process restart. This is handled via a **Periodic Configuration Refresh** mechanism.

### The Refresh Cycle

Every 4 hours (default `BLOCKCHAIN_FETCH_INTERVAL_MIN`), the bot performs the following safe refresh cycle:

1.  **Thread-Safe Load**: The bot re-reads `profiles/bots.json` using `readBotsFileWithLock` to ensure it doesn't collide with manual edits or the CLI manager.
2.  **Memory Update**: It identifies its own configuration entry and updates its internal memory state (`this.config` and `manager.config`).
3.  **Non-Disruptive Application**: The refresh is designed to be **passive**. It updates valuation anchors but does **not** trigger on-chain order movement automatically.

### Configuration Authority: `startPrice` / `poolRef`

The `startPrice` parameter follows a strict hierarchy of authority:

| Setting Type | Source | Behavior |
|--------------|--------|----------|
| **Numeric** | `bots.json` | **Single Source of Truth**. Blocks all auto-derivation. Used as a fixed anchor for valuation and grid resets. |
| **"pool"** | Blockchain | Derived from current Liquidity Pool price during resets or 4h refresh cycles. |
| **"pool" + poolRef** | Blockchain | Same as `"pool"`, but pool is fetched directly by ID (`get_objects`) bypassing discovery. Set `poolRef` in `bots.json` (e.g. `"1.19.48"`) to pin a proxy pool. |
| **"book"** | Blockchain | Derived from current order book price during resets or 4h refresh cycles. |

---

## Data Persistence

```mermaid
graph LR
    subgraph "In-Memory State"
        ORDERS[orders Map<br/>Grid state]
        FUNDS[funds Object<br/>Fund tracking]
        INDICES[Indices<br/>_ordersByState<br/>_ordersByType]
    end

    subgraph "Persisted State"
        ORDERS_JSON[<botKey>.json<br/>Grid snapshot<br/>feesOwed, boundaryIdx, btsBalance]
        BOTS_JSON[bots.json<br/>Bot config]
    end

    ORDERS --> ORDERS_JSON
    FUNDS --> ORDERS_JSON

    ORDERS_JSON -.->|Load on startup| ORDERS
    ORDERS_JSON -.->|Load on startup| FUNDS

    BOTS_JSON -.->|Load on startup| CONFIG[Bot Config]
```

### Persistence Strategy

- **Grid state**: Persisted after every rebalance to `<botKey>.json` in `profiles/orders/`
- **Fund state**: Available funds derived from blockchain balances at runtime (no separate persistence needed)
- **Retry logic**: 3 attempts with exponential backoff
- **Graceful degradation**: Bot continues if persistence fails (in-memory only)

---

## Memory-Only Integer Tracking

The system has been optimized to use a "memory-driven" model for order updates, eliminating redundant blockchain API calls during normal operation.

### How it works

- **Raw order cache (`rawOnChain`):** each grid slot stores the exact blockchain order integers
  (satoshis) — seeded from broadcast arguments on placement, updated in place on partial fills,
  and refreshed on updates/rotations.
- **Chain-free planning:** size updates and rotations build their operations from the cache;
  only placements and recovery syncs query the blockchain.
- **`buildUpdateOrderOp(cachedOrder?)`:** accepts an optional cached order and returns
  `finalInts` alongside the operation for local tracking.
- **Self-healing:** a failed memory-driven transaction triggers a full state-recovery sync so the
  internal ledger stays consistent with the chain.

### Benefits
- **Faster reaction time**: No waiting for blockchain queries during order updates
- **Reduced API load**: Fewer fetches, less network congestion
- **Mathematical precision**: Integer-based tracking prevents float precision errors
  - *See [FUND_MOVEMENT_AND_ACCOUNTING.md § 5.5](FUND_MOVEMENT_AND_ACCOUNTING.md#55-precision--quantization) for quantization utilities and best practices*
- **Fallback safety**: Automatic recovery if memory state becomes inconsistent

### Performance Impact
- Batch operations (size updates, rotations) now run without any blockchain fetches
- Only placement operations and recovery syncs query the blockchain
- Estimated **10-20x speedup** for high-frequency operations

---

## Error Handling & Safety

### Fund Invariants

The system continuously monitors three mathematical invariants:

1. **Account Equality**: `chainTotal = chainFree + committed.chain`
2. **Committed Ceiling**: `committed.grid <= chainTotal`
3. **Available Leak Check**: `available <= chainFree`

**Tolerance**: 0.1% (to account for fees and rounding)

### Index Consistency

- **Grid versioning**: `_gridVersion` is bumped on every grid mutation; the
  `_ordersByType` / `_ordersByState` index caches invalidate automatically when the
  version changes (no manual rebuild step)
- **Structural checks**: tests use `assertOrdersStructurallySound()`
  (`tests/helpers/order_test_helpers.ts`) to verify every order in the Map is non-null
  with valid `state` and `type`

---

## Performance Considerations

### Optimization Strategies

1. **Batch fund recalculation**: `pauseFundRecalc()` / `resumeFundRecalc()`
2. **Index-based lookups**: O(1) access via `_ordersByState` and `_ordersByType`
3. **Lock expiry**: Prevents permanent blocking from crashes
4. **Fee caching**: Reduces blockchain API calls

### Metrics Tracking

```javascript
bot.getMetrics()
// Returns (OrderManager._metrics plus live pipeline state):
// - fillsProcessed, batchesExecuted, fillProcessingTimeMs, maxQueueDepth
// - fundRecalcCount, lastSyncDurationMs, metricsStartTime
// - lockAcquisitions, lockContentionEvents, lockContentionSkips, gridLockContention
// - spreadRoleConversionBlocked
// - queueDepth, fillProcessingLockActive, divergenceLockActive, shadowLocksActive
// - recoveryExhaustedAt, recentFillsTracked
// - unmatchedChainOrders, heldChainOrders, blockingChainOrders
```

---

### Zero-Dependency Policy

DEXBot2 operates under a **zero mandatory production dependency** policy. The dependency tree is empty — every production capability (blockchain client, WebSocket transport via Node's native `globalThis.WebSocket`, crypto/signing, serialization, testing, price feeds, credential vault) is implemented natively within the codebase. Requires **Node.js >= 22.12** for the built-in WebSocket.

**Why:** Trading bots handle real money. Every external dependency is a supply-chain risk surface. Keeping the dependency tree empty means no `npm audit` surprises, no supply-chain attacks on upstream packages, and no version-migration overhead for the core runtime.

**Special case — trading bots:** This level of dependency discipline is rare in open-source trading software. Established projects (Gekko, Freqtrade, Hummingbot) carry 15–20+ production dependencies. DEXBot2's empty dependency tree is a deliberate architectural choice, not an accidental outcome — it reflects the project's priority of operational safety over developer convenience.

**What this means in practice:**
- Blockchain connectivity (`bitshares-native/`) — hand-rolled from protocol primitives
- Elliptic curve crypto (secp256k1) — native JS, zero native addons
- Testing — `node:assert`, no Jest/Mocha/Vitest
- Persistence — JSON flat files, no SQLite/ORM
- Price sources — native candle fetching, no CCXT/CoinGecko
- Process management — PM2 ecosystem or direct Node.js, no Docker requirement

### Testing Strategy & Quality Assurance

DEXBot2 uses a native Node.js `assert` testing strategy to ensure reliability without heavy dependencies.

### Test Coverage by Module

```mermaid
graph LR
    A["Logic Tests<br/>(tests/test_*_logic.ts)"]
    B["Integration Tests<br/>(tests/test_*.ts)"]
    C["Signal Tests<br/>(tests/test_*_signal*.ts)"]
    D["Credit/Debt Tests<br/>(tests/test_*_credit*.ts)"]

    A -->|Manager, State Machine| A1["manager_logic"]
    A -->|Fund Tracking| A2["accounting_logic"]
    A -->|Grid Creation| A3["grid_logic"]
    A -->|Rebalancing| A4["strategy_logic"]
    A -->|Sync Logic| A5["sync_logic"]

    B -->|Multi-step Scenarios| B1["Market Scenarios"]
    B -->|Edge Cases| B2["Partial Order Tests"]
    B -->|Real-world Scenarios| B3["Fills/FEE Tests"]

    C -->|Dynamic Weight| C1["dynamic_weight"]

    D -->|CR Planner| D1["cr_planner"]
    D -->|Credit Runtime| D2["credit_runtime"]
    D -->|MPA Wiring| D3["dexbot_credit_wiring"]
```

### Running Tests

```bash
# Run all tests (native assert)
npm test

# Specific logic area
node dist/tests/test_accounting_logic.js

# Signal tests
node dist/tests/test_market_adapter_signal_gates.js
node dist/tests/test_dynamic_weight_override_wiring.js

# Credit/debt tests
node dist/tests/test_cr_planner.js
node dist/tests/test_dexbot_credit_wiring.js
```

### Test Quality Metrics

**Coverage Goals:**
- ✅ All public methods have tests
- ✅ All invariants verified automatically
- ✅ Edge cases covered (zero funds, max orders, etc.)
- ✅ Concurrent operations tested with locks
- ✅ State transitions validated end-to-end
- ✅ Signal pipelines tested (dynamic weight)
- ✅ Credit/debt runtime tested (CR planner, MPA wiring)

**Test Suite Evolution:**
- 50+ test cases for signal intelligence and credit runtime
- Dynamic weight override and market adapter signal gate tests
- Credit/debt tests with CR planner and MPA wiring validation

### Testing Best Practices

**For Developers:**

1. **Run tests before commits**
   ```bash
   npm test
   ```

2. **Add tests for new features**
   - Follow patterns in existing tests
   - Test fund impact of new logic
   - Include edge cases

3. **Verify invariants**
   ```javascript
   assertOrdersStructurallySound(manager);  // Order Map structurally valid
   expect(chainTotal === chainFree + chainCommitted).toBe(true);
   ```

4. **Use debug mode for problematic scenarios**
   ```javascript
   manager.logger.level = 'debug';  // Enable detailed logging
   // ... run scenario ...
   // Check console output for detailed fund tracking
   ```

### Test Documentation References

- **[tests/README.md](../tests/README.md)** - Test suite organization, categories, and running instructions

- **[developer_guide.md#testing-fund-calculations](developer_guide.md#testing-fund-calculations)** - Testing guide for developers
  - How to write fund tests
  - Common test patterns
  - Debugging failing tests
  - Adding tests for new features

---

## Market Adapter Signal Pipeline

The market adapter runs as a standalone process that computes AMA-derived grid prices, trend signals, dynamic weights, and collateral-ratio advisories.

### Signal Flow

```
price_candles -> AMA -> gridCenterPrice
                |
                +-> slope_analysis -> trend_offset (asymmetric weight shift)
                |
price_candles -> ATR -> weight_variance (symmetric shift)
                |
                +-> regime_detection (Hurst/PE) -> regime_filter
                |
                +-> Kalman_confirmation -> blended_dynamic_weight
```

### Outputs (per cycle, per bot)
- `gridCenterPrice` — AMA center price, clamped to min/max bounds
- `weights` — `{ buy, sell }` dynamic grid weighting
- `collateralRecommendation` — advisory collateral ratio hint
- `trend` / `atr` — raw regime and volatility signals
- Trigger files when the adapter accepts the first AMA center, the grid price delta exceeds threshold, or whitelisted range-scaling slope delta exceeds threshold

### Integration with Bot Runtime

1. Adapter persists `profiles/orders/<botKey>.dynamicgrid.json` before any reset trigger.
2. Adapter writes `profiles/recalculate.<botKey>.trigger` for bootstrap, AMA-center delta, or whitelisted AMA-slope range reset.
3. `dexbot_maintenance_runtime.ts` consumes the trigger under `_fillProcessingLock`, with idle/dust deferral when needed.
4. Bot runtime reads accepted center, range-scaling fields, and dynamic weights from the dynamic-grid snapshot during reset and selected maintenance paths.

---

## Credential Security Architecture

DEXBot2 uses a hardened credential daemon (`credential-daemon.ts`) for key management and signing.

### Security Layers
- **Vault v2**: scrypt (N=2^17) key derivation, per-record HKDF isolation, AES-256-GCM encryption
- **Daemon-backed signing**: Primary bot flow uses signing tokens; all signing happens inside the daemon, raw keys never exported
- **Session cache**: Encrypted HKDF re-encryption with a random salt never persisted
- **Runtime hardening**: lstat + owner/mode/type checks on all sockets and ready files; bootstrap socket destroyed after first use
- **Strict daemon policy**: Memory safety and zeroing, session hardening, signing cache with time-based expiry

### PM2 Integration

`dexbot pm2` unlocks `dexbot-cred` through a one-shot local bootstrap channel instead of exporting the master password to every PM2 app. Use `dexbot pm2 restart ...` for DEXBot-managed PM2 actions.

---

## Credit/Debt Runtime

Native DEXBot2 support for MPA borrowing and credit offer workflows. The logic is split between a pure-math planner and a lifecycle runtime:

| Module | Role |
|--------|------|
| **`modules/cr_planner.ts`** | **Pure math / credit planning** — debt-first CR adjustments, derived order sizing. No I/O, no side effects; safe to unit-test in isolation. |
| **`modules/credit_runtime.ts`** | **Lifecycle management** — applies the planner's output to the chain, enforces policy, drives watchdog cadence and grid-reset coupling. |

### Scope
- **MPA borrowing**: Call-order updates with debt-first CR planning
- **Credit offers**: Accept/repay with auto-reborrow, LP-backed collateral valuation
- **Policy enforcement**: Per-bot `debtPolicy` with hard CR floors/ceilings and max fee rates
- **Grid reset coupling**: Every successful CR adjustment requests a grid rebuild

### Runtime Rules
- Evaluates on the dedicated credit watchdog interval
- No separate enable switch — active when `debtPolicy.lending` is present, non-empty, and every item declares `collateralAsset`
- Claw can read the same bot policy without redefining rules (via `claw/modules/credit_runtime_adapter.ts`)

---

## Grid Rebalancing Robustness

The strategy engine has been significantly strengthened with improvements to fund validation, dust handling, and order constraints:

**1. Pre-Flight Fund Validation**
- Before executing batch order placements, available funds are validated
- Prevents insufficient fund errors during large rotation cycles
- Uses atomic check-and-deduct pattern for safety
- Located in: `modules/dexbot_cow_runtime.ts` - `validateOperationFunds()`

**2. Dust Partial Handling**
- Improved dust detection algorithm prevents false positives
- Detects dust as `< 5% of ideal order size`
- **Immediate Cancellation**: `_cancelDustOrders()` cancels dust partials on-chain when detection runs — no delay, timer map, or consolidation cycle. Detection runs after fills/sync, and a 5-minute health check is the restart safety net.

**3. Strict Order Size Constraints**
- Orders validated to not exceed available funds
- Maximum order size enforced during both placement and rotation
- Prevents oversized orders that fail on-chain
- Atomic validation with placement ensures consistency

**4. Boundary Index Persistence**
- BoundaryIdx (spread zone pivot) now correctly persisted across bot restarts
- Ensures grid rotation continues seamlessly after divergence correction
- Fixes grid instability from incorrect boundary tracking

**5. Taker Fee Accounting**
- Both market and blockchain taker fees now accounted for correctly
- Fee deduction uses proper `isMaker` parameter
- Prevents fund leaks from missing fee calculations
- Located in: `modules/order/manager.ts` - `processFilledOrders()`

**6. Precision Spread Management (Logarithmic Logic)**
- **Discrete Step Tracking**: A discrete 1-slot logarithmic buffer ensures correction triggers exactly when the market moves by one full increment.
- **Center-Gap Awareness**: Grid initialization math accounts for the "Center Gap" naturally created during symmetric centering, reducing the initial spread by ~0.5% (one full increment).
- **Collision-Free Safety**: `MIN_SPREAD_FACTOR` of 2.1 ensures that the security minimum (2 spread orders) never conflicts with the spread correction threshold, even at micro-spread configurations.

### Related Documentation

For detailed fund calculations and test coverage, see:
- [developer_guide.md#testing-fund-calculations](developer_guide.md#testing-fund-calculations) - How fund calculations are tested
- [tests/README.md](../tests/README.md) - Test suite organization and running instructions

---

- [Fund Movement Logic](FUND_MOVEMENT_AND_ACCOUNTING.md) - Detailed mathematical formulas and algorithms
- [Developer Guide](developer_guide.md) - Code navigation and onboarding
- [README](../README.md) - User documentation and setup
- [WORKFLOW.md](WORKFLOW.md) - Git branch workflow

---

## Quick Reference

### Common Code Patterns

**Get orders by state and type:**
```javascript
const activeBuys = manager.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE);
```

**Atomic fund deduction:**
```javascript
if (manager.accountant.tryDeductFromChainFree(orderType, size)) {
    // Funds deducted, safe to place order
} else {
    // Insufficient funds, skip
}
```

**Batch order updates:**
```javascript
manager.pauseFundRecalc();
for (const order of orders) {
    // context parameter helps with logging/debugging the source of the update
    manager._updateOrder(order, 'batch-update', { skipAccounting: false, fee: 0 });
}
manager.resumeFundRecalc(); // Recalculates once
```

**Lock orders during async operations:**
```javascript
manager.lockOrders([orderId]);
try {
    await asyncOperation();
} finally {
    manager.unlockOrders([orderId]);
}
```

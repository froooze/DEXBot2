# Copy-on-Write (COW) Grid Master Plan

**Author:** froooze  
**Status:** Implemented & Stabilized  
**Objective:** Eliminate optimistic state corruption by separating "Blockchain Truth" from "Strategy Targets" using immutable master grids and Copy-on-Write semantics.

## Overview

The Copy-on-Write (COW) Grid Architecture replaces the old optimistic mutation pattern with a cleaner approach: **master grid is never modified until blockchain confirmation**.

This architecture implements the core philosophy of **"Verify, Then Commit"**:

1. **Immutable Master Grid:** The master grid is never directly modified during planning.
2. **Atomic Promotion:** Changes only move from working copy to master upon verified blockchain success.
3. **Delta-Only Execution:** Only the difference between Master and Target triggers blockchain actions.
4. **Side Invariance:** Order side (BUY/SELL) is absolute. Any price-flip requires a full `Cancel` → `Place` sequence.

## Architecture

### COW Pattern

```
1. Create WorkingGrid (clone of master)
2. Modify working copy
3. Broadcast to blockchain
4. On success: atomic swap (working → master)
5. On failure: discard working (master unchanged)
```

### Freeze + COW Hybrid

The production implementation uses both `Object.freeze()` and COW as complementary layers:

1. **`Object.freeze()`** on the master Map and `deepFreeze()` on individual order objects
   provides runtime enforcement — any accidental direct mutation throws in strict mode.
   Each `_applyOrderUpdate` call creates a new frozen Map via immutable-swap pattern:

   ```javascript
   const newMap = cloneMap(this.orders);
   newMap.set(id, deepFreeze({ ...nextOrder }));
   this.orders = Object.freeze(newMap);
   ```

2. **COW working grids** provide the planning/broadcast lifecycle isolation — strategy
   computes target state on a mutable clone, and master is only replaced after blockchain
   confirmation via `_commitWorkingGrid()`.

The freeze layer catches bugs that COW alone wouldn't (e.g., code that reads `manager.orders`
and mutates an order object in-place). The COW layer provides the transactional semantics
(plan, broadcast, commit-or-discard).

## State Machine

```
NORMAL → REBALANCING → BROADCASTING → _commitWorkingGrid() → NORMAL
                                          ↓ (on failure)
                                    _clearWorkingGridRef() → NORMAL
                                        (master unchanged)
```

**State transitions:**
- `NORMAL → REBALANCING`: `_applySafeRebalanceCOW()` begins planning.
- `REBALANCING → BROADCASTING`: `_updateOrdersOnChainBatchCOW()` starts blockchain ops.
- `BROADCASTING → NORMAL`: `_clearWorkingGridRef()` always called on exit (success or failure).
- Fill during `REBALANCING`/`BROADCASTING`: marks working grid stale, syncs order from master.

**COW State Machine Cheat Sheet:**

| State | Fill Handling | Working Grid Action | Commit Outcome |
|-------|---------------|---------------------|----------------|
| `NORMAL` | Apply fill to master immediately | No working-grid sync | Not applicable |
| `REBALANCING` | Apply fill to master immediately | Mark stale + sync changed order from master | Planning returns aborted result |
| `BROADCASTING` | Apply fill to master immediately | Mark stale + sync changed order from master | Commit guard rejects stale/version-mismatch grid |

**Single-source rules (no special cases):**
- Master grid always updates first (blockchain truth).
- If planning/broadcasting is active, sync the changed order into the working grid.
- Any master mutation marks the working grid stale.
- Commit succeeds only when stale/version/delta guards all pass.

### Atomic Boundary Shifts

Boundary index changes during divergence correction are atomic with slot-type reassignment:
`pendingBoundaryIdx` carries boundary changes through the COW pipeline and `manager.boundaryIdx`
is untouched until `_commitWorkingGrid` completes. This prevents transient mismatches between
boundary position and slot BUY/SELL roles during blockchain execution.

## Data Flow

### Normal Rebalance Flow

```
1. performSafeRebalance(fills, excludeIds)
   └─> _applySafeRebalanceCOW()
       ├─> Create WorkingGrid (clone master)
       ├─> Calculate target grid (from strategy)
       ├─> Reconcile against working copy
       └─> Return { workingGrid, actions, ... }

2. updateOrdersOnChainBatch(result)
   └─> _updateOrdersOnChainBatchCOW()
        ├─> Lock order IDs
        ├─> Build blockchain operations
        ├─> Pre-broadcast staleness guard (evaluateCommit):
        │   ├─> Plan stale (master mutated mid-planning) => replanStaleBatch:
        │   │   ├─> Re-plan ONCE from fresh master with same fills
        │   │   ├─> Restore boundary-shift budget + clear only the abandoned
        │   │   │   batch's own pending-broadcast entries
        │   │   ├─> No executable actions => skip stale plan (grid already consistent)
        │   │   └─> Still stale / no fill context => proceed + structural resync
        │   └─> Plan valid => continue
        ├─> Execute batch
        ├─> On success:
        │   ├─> _commitWorkingGrid()  → atomic swap
        │   │   └─> commit refused (master changed during broadcast)
        │   │       └─> adopt placed orders from chain; keep pending-broadcast
        │   │           protection + structural resync if adoption unavailable
        │   └─> persistGrid()          → write to disk
        └─> On failure:
            └─> workingGrid discarded (master unchanged)
```

### Fill Processing Flow

```
NEW FILL ARRIVES
   │
   ▼
[ Type of update? ]
   │
   ├─ individual fill (boundary shift only)
   │     update master grid
   │     sync working grid if planning active
   │     continue current operations
   │
   └─ full side update (divergence / cache threshold)
         │
         ├─ BROADCASTING  => abort; discard working grid
         ├─ REBALANCING   => block; wait for fills=0
         └─ NORMAL        => safe to proceed
```

## Fill Handling Strategy

**Decision:** "Selective abort — continue individual fills, block full-side updates."

| Scenario | Scope | Action | Reason |
|----------|-------|--------|--------|
| Individual fill | Single slot (boundary shift) | Process immediately | Just moves boundary, doesn't modify filled order. Low risk. |
| Divergence-triggered full update | Entire side of grid | Block if fills pending | Rebuilding all orders — needs stable state, no concurrent fills. |
| Cache threshold full update | Entire side of grid | Block if fills pending | Rebalancing depleted side — complex planning, can't have stale data. |

### Individual Fills (Grid Maintenance)

- Only move boundary and handle next slot — **don't modify the filled order itself**.
- Fills keep the grid alive by shifting the boundary as market moves.
- Low risk, can sync to working grid and continue current rebalance.
- **Never abort blockchain operations for individual fills.**

### Full Side Updates (Major Planning)

- Divergence: rebuild entire side of grid (potentially dozens of orders).
- Cache threshold: rebalance all orders on depleted side.
- High risk — complex planning that shouldn't run with stale state.
- **Block if fills pending or during `BROADCASTING`.**

**Key distinction:** individual fills move the boundary; full updates rebuild everything.

### Divergence & Cache Checks Blocked During Rebalance

```javascript
if (fills.length === 0 && rebalanceState === REBALANCE_STATES.NORMAL) {
    // Safe to check divergence
    // Safe to update cache functions
}
```

**Why this restriction:**
- Divergence calculations assume stable grid state.
- Fills modify the grid mid-calculation.
- Cache updates must reflect committed state, not speculative working state.
- Prevents race conditions between fill processing and cache invalidation.

### Working Grid Synchronization

When fills arrive during `REBALANCING` state (before `BROADCASTING`):

1. Update master grid immediately (blockchain truth).
2. **Also apply same fill to working grid** (keep copies in sync).
3. Continue with current rebalance using updated working copy.

```javascript
// Implementation in _applyOrderUpdate (manager.ts)
async _applyOrderUpdate(order, context, options = {}) {
    // ... update master grid (immutable swap) ...

    // Centralized adapter handles:
    // 1) planning-state gate,
    // 2) markStale(),
    // 3) syncFromMaster(),
    // 4) sync error handling.
    this._syncWorkingGridFromMasterMutation(order.id, context);
}

// WorkingGrid.syncFromMaster (working_grid.ts)
syncFromMaster(masterGrid, orderId, masterVersion?) {
    const masterOrder = masterGrid.get(orderId);
    if (masterOrder) {
        this.grid.set(orderId, this._cloneOrder(masterOrder));
        this.modified.add(orderId);
        this._indexes = null;
    }
    if (Number.isFinite(masterVersion)) {
        this.baseVersion = masterVersion;
    }
}
```

**Why this matters:**
- Working grid must reflect all blockchain state changes.
- Prevents stale data from being committed.
- Avoids unnecessary aborts for individual fills.

## Key Methods

### OrderManager (`modules/order/manager.ts`)

| Method | Description |
|--------|-------------|
| `performSafeRebalance(fills, excludeIds)` | Entry point — delegates to COW |
| `_applySafeRebalanceCOW(fills, excludeIds)` | Creates working grid, runs planning |
| `WorkingGrid.buildDelta(masterGrid)` | Delta between master and working copy (`modules/order/working_grid.ts`, delegating to `utils/order.ts`) |
| `_commitWorkingGrid(workingGrid, indexes, boundary, options = {})` | Atomic swap to master |
| `_setRebalanceState(state)` | Track rebalance state |
| `_currentWorkingGridStack` | Stack of active working-grid references during rebalance for fill sync; peek the innermost via `_peekWorkingGrid()`, managed with `_pushWorkingGridRef`/`_popWorkingGridRef`/`_releaseWorkingGridRef`/`_clearWorkingGridRef` |
| `_applyOrderUpdate(order, context, options = {})` | Lock-free order update (immutable swap); routes fill sync to `_syncWorkingGridFromMasterMutation` |
| `_syncWorkingGridFromMasterMutation(orderId, context)` | Adapter: planning-state gate → `markStale()` + `syncFromMaster()` → sync error handling |

### DEXBot (`modules/dexbot_class.ts`)

| Method | Description |
|--------|-------------|
| `updateOrdersOnChainBatch(rebalanceResult)` | Routes to COW broadcast |
| `_updateOrdersOnChainBatchCOW(rebalanceResult)` | Full COW broadcast with commit |

### WorkingGrid (`modules/order/working_grid.ts`)

| Method | Description |
|--------|-------------|
| `syncFromMaster(masterGrid, orderId, masterVersion?)` | Sync specific order from master to working grid during fill processing |
| `buildDelta(masterGrid)` | Build delta actions between master and working grid |
| `getIndexes()` | Get cached grid indexes |

## Operational Rules

### 1. Fill Priority Always Wins
Filled orders are blockchain truth and always processed immediately. See the
**Fill Handling Strategy** section for the full Individual Fills vs Full Side Updates rules.

### 2. Divergence & Cache Checks Blocked During Rebalance
Divergence detection and cache function updates are deferred when fills are pending or when
rebalancing is in progress. See **Fill Handling Strategy → Divergence & Cache Checks Blocked
During Rebalance**.

## Safety Guardrails

1. **Planning-time budget feasibility:** order sizes are derived from `funds.allocated` via `getSideBudget` / `_getSizingContext`, so a proposed grid cannot exceed the side budget by construction. (The historical `Accountant.validateTargetGrid` dry-run was removed — it had no production caller.)
2. **Atomic Transaction Semantics:** Large boundary shifts (>5 slots) are inherently safe because the COW pattern only commits after successful blockchain confirmation. If market volatility causes rapid shifts during planning, the plan is caught by the **pre-broadcast staleness guard** (`evaluateCommit` against `_gridVersion`): it re-plans ONCE from the fresh master with the same fills (`replanStaleBatch`, bounded by `STALE_PLAN_REPLAN_LIMIT`), then proceeds + structural resync if still stale — never a silent discard that drops the fill set. If the master changes *during* broadcast, the commit-time guard refuses the commit and the placed orders are adopted from chain so on-chain state never runs ahead of the grid.
3. **Resync on Error:** If any blockchain action fails (e.g., "Insufficient funds"), the bot discards the working grid and triggers `grid_reconcile.ts` for a fresh blockchain sync ([GRID_RECONCILE.md](GRID_RECONCILE.md)).

## Backward Compatibility

None. COW is the **only standard**. The old snapshot/rollback pattern has been completely removed.

## Verification

This architecture makes the "Metadata Reinterpretation" bug impossible by ensuring that memory is only a reflection of verified blockchain state. The master grid is never partially modified — it's either the old state or the new state, with no intermediate "limbo" states.

---

## Appendix: COW Constants (`modules/constants.ts`)

### COW Performance Thresholds
- `COW_PERFORMANCE.MAX_REBALANCE_PLANNING_MS` — planning-phase duration above which a slow-plan warning is logged (100ms).
- `COW_PERFORMANCE.GRID_MEMORY_WARNING` — working grid size (bytes) that triggers a memory warning (5,000).
- `COW_PERFORMANCE.WORKING_GRID_BYTES_PER_ORDER` — estimated memory per order (500 bytes).
- `COW_PERFORMANCE.MAX_OPS_PER_BROADCAST` — *removed*; the per-broadcast operation cap is now derived from the grid gap-slot count + 1 (`DEXBot._getGapSlotBatchSize`); larger batches are split into sequential broadcasts.

### Pipeline Timing
- `PIPELINE_TIMING.RECOVERY_DECAY_FALLBACK_MS` — recovery decay fallback (180 seconds).

### Grid & Timing
- `GRID_LIMITS.RELATIVE_ORDER_UPDATE_THRESHOLD_PERCENT` — relative threshold (%) for in-memory COW order equality checks.
- `TIMING.LOCK_REFRESH_MIN_MS` — minimum lock refresh interval (250ms).

## Appendix: Validation Gates

Run these tests before promotion:
- `node dist/tests/test_engine_integration.js`
- `node dist/tests/test_sequential_multi_fill.js`
- `node dist/tests/test_sync_logic.js`
- `node dist/tests/test_ghost_order_fix.js`
- `node dist/tests/test_working_grid.js`
- `node dist/tests/test_cow_master_plan.js`
- `node dist/tests/test_cow_commit_guards.js`
- `node dist/tests/test_cow_concurrent_fills.js`
- `node dist/tests/test_cow_divergence_correction.js`
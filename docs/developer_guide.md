# DEXBot2 Developer Guide

Welcome to DEXBot2! This guide will help you understand the codebase, navigate key concepts, and contribute effectively.

> **For system design overview**, see [architecture.md](architecture.md) which provides high-level module relationships and data flows.

---

## Quick Start: Where to Begin

### 1. **Start Here** (5 minutes)
Read these files in order to get oriented:
1. [README](../README.md) - User documentation and setup
2. [LIFECYCLE.md](LIFECYCLE.md) - **End-to-end walkthrough** (startup, fill-driven, and AMA-driven flows with diagrams) — read this first for the big picture
3. [architecture.md](architecture.md) - System architecture and module relationships
4. [FUND_MOVEMENT_AND_ACCOUNTING.md](FUND_MOVEMENT_AND_ACCOUNTING.md) - Core algorithms and formulas

### 2. **Core Concepts** (15 minutes)
Understand these fundamental concepts before diving into code:
- **Grid Trading**: Placing orders at geometric price levels to profit from volatility
- **Order States**: VIRTUAL → ACTIVE → PARTIAL lifecycle
- **Fund Tracking**: Atomic accounting to prevent overdrafts
- **Boundary Crawl**: Dynamic order rotation following price movement
- **Copy-on-Write (COW)**: Master grid is immutable. All rebalancing runs on an isolated `WorkingGrid` clone; the master is replaced atomically only after blockchain success. See [COPY_ON_WRITE_MASTER_PLAN.md](COPY_ON_WRITE_MASTER_PLAN.md).

### 3. **Code Reading Roadmap** (30-40 minutes)
Follow this path through the codebase:

```
1. modules/constants.ts                    (5 min)   - Configuration and tuning parameters
2. modules/order/manager.ts                (10 min)  - Central coordinator, read constructor + _updateOrder() + _applySafeRebalanceCOW() + _commitWorkingGrid()
3. modules/order/working_grid.ts           (5 min)   - COW working copy; read syncFromMaster() + buildDelta()
4. modules/order/accounting.ts             (5 min)   - Fund tracking, read recalculateFunds() and resetRecoveryState()
5. modules/order/strategy.ts               (5 min)   - Target grid calculation, read calculateTargetGrid()
6. modules/order/grid.ts                   (5 min)   - Grid creation, read createOrderGrid()
7. modules/dexbot_fill_runtime.ts          (5 min)   - Fill batch processing pipeline and replay-safe accounting
8. modules/dexbot_maintenance_runtime.ts   (5 min)   - Sync loops, grid maintenance, trigger handling
9. modules/dexbot_class.ts                 (5 min)   - Bot lifecycle, credit runtime startup, maintenance orchestration
```

**Additional Resources**:
- `modules/constants.ts::FILL_PROCESSING` - Fill-event handling configuration (batch sizing is gap-slot derived, see `DEXBot._getGapSlotBatchSize`)
- `modules/constants.ts::PIPELINE_TIMING` - Recovery configuration (RECOVERY_RETRY_INTERVAL_MS, MAX_RECOVERY_ATTEMPTS)
- `modules/constants.ts::MARKET_ADAPTER` - AMA, dynamic weight, and regime detection defaults
- `modules/constants.ts::REGIME_TABLE` - Hurst/PE regime signal-strength table
- `modules/dexbot_class.ts::_handleBatchHardAbort()` - Hard-abort recovery handler
- `bot._staleCleanedOrderIds` (`modules/dexbot_fill_runtime.ts`, typed in `modules/types.ts`) - Orphan-fill deduplication tracking
- `bot._cancelDustOrders()` (`modules/dexbot_maintenance_runtime.ts` / `modules/dexbot_fill_runtime.ts`) - Auto-cancel dust partials on-chain immediately (no timer)
- `modules/credit_runtime.ts` - Debt workflow executor (MPA and credit offer)
- `market_adapter/core/market_adapter_service.ts` - Signal pipeline (AMA, dynamic weights, collateral advisory)

---

## Glossary of Terms

### Order States

| Term | Meaning | Fund Impact |
|------|---------|-------------|
| **VIRTUAL** | Order planned but not on-chain | Funds reserved in `virtual` pool |
| **ACTIVE** | Order placed on blockchain | Funds locked in `committed.chain` |
| **PARTIAL** | Order partially filled | Reduced `committed`, proceeds added to `chainFree` |
| **SPREAD** | Placeholder for spread zone | Always VIRTUAL, no funds |

⚠️ **CRITICAL: Phantom Orders**

A **phantom order** is an order in ACTIVE/PARTIAL state WITHOUT a valid `orderId`. This is an illegal state that corrupts fund tracking. The system implements a three-layer defense to prevent phantoms (see **Phantom Orders Prevention** section). If encountered, the order is automatically downgraded to VIRTUAL with error logging.

### Pipeline Safety Features

#### Pipeline Timeout & Health

| Term | Meaning |
|------|---------|
| **Pipeline Timeout Safeguard** | 5-minute timeout preventing indefinite blocking on pipeline checks |
| **Stale Operation Clearing** | Non-destructive recovery clearing operation flags without touching orders |

#### Fill Batching & Recovery Retries

| Term | Meaning |
|------|---------|
| **Gap-Slot Batch Fill Processing** | Groups fills using the grid gap-slot count + 1 as batch size (`DEXBot._getGapSlotBatchSize`): `<= gapSlots + 1` uses one unified batch; `> gapSlots + 1` chunks at `gapSlots + 1`. In the documented 29-fill Feb 7 crash scenario, this reduces the estimated divergence window from ~90s to ~24s; see [`FUND_MOVEMENT_AND_ACCOUNTING.md`](FUND_MOVEMENT_AND_ACCOUNTING.md#15-fill-batch-processing--timeline). |
| **Recovery Retry System** | Count+time-based retry mechanism with periodic reset. Replaces one-shot `_recoveryAttempted` flag. Max 5 attempts per episode with 60s minimum interval between retries. |
| **Orphan-Fill Deduplication** | Map+TTL-based tracking of stale-cleaned order IDs to prevent double-crediting. Delayed orphan fill events are still blocked by checking `_staleCleanedOrderIds`. |

#### Cache & Stale-Order Handling

| Term | Meaning |
|------|---------|
| **Remainder Tracking** | Remainder derived from actual allocated sizes during capped grid resizes (not ideal sizes). Ensures accurate available fund calculations for next rebalance cycle. |
| **Stale-Order Fast-Path** | Stale-cancel logic applies to single-op batches for fast recovery without triggering full state syncs. Prevents unnecessary expensive resynchronization. |
| **Hard-Abort Cooldown Consistency** | Both primary and retry batch hard-abort paths explicitly arm `_maintenanceCooldownCycles` to prevent premature maintenance after recovery. |

### Fund Components

| Term | Meaning | Formula |
|------|---------|---------|
| **chainFree** | Unallocated blockchain balance | From `accountTotals.buyFree/sellFree` |
| **committed.chain** | Funds locked in on-chain orders | Sum of ACTIVE orders with `orderId` |
| **committed.grid** | Internal tracking of ACTIVE sizes | Sum of all ACTIVE order sizes |
| **virtual** | Reserved for VIRTUAL orders | Sum of VIRTUAL order sizes |
| **available** | Free funds for new orders | `max(0, chainFree - virtual - fees)` |
| **total.chain** | Total on-chain balance | `chainFree + committed.chain` |
| **total.grid** | Total grid allocation | `committed.grid + virtual` |

### Copy-on-Write (COW) Concepts

| Term | Meaning |
|------|---------|
| **Master Grid** (`manager.orders`) | The immutable source of truth. Frozen with `Object.freeze()`. Never mutated in place—replaced atomically via `_commitWorkingGrid()` only after blockchain success. |
| **WorkingGrid** | Mutable clone of the master grid used during planning. Created by `new WorkingGrid(masterGrid)`. Discarded on failure; committed on success. Lives in `modules/order/working_grid.ts`. |
| **COW Rebalance** | The full plan→broadcast→commit cycle: `_applySafeRebalanceCOW()` → `_updateOrdersOnChainBatchCOW()` → `_commitWorkingGrid()` |
| **Atomic Commit** | `_commitWorkingGrid(workingGrid, indexes, boundary, options = {})` swaps master to the working copy in a single operation, then increments `_gridVersion`. |
| **Staleness / Version Mismatch** | If a fill mutates the master grid while a rebalance is in progress, the working grid is marked stale. The commit guard rejects stale or version-mismatched working grids. Spread correction additionally holds the broadcast region across a bounded fresh-master re-plan ([architecture.md](architecture.md) → Spread Correction → Resilience). |
| **`_gridVersion`** | Integer counter incremented on every master-grid mutation. Used by commit guards to detect concurrent master changes. |
| **`_gridLock`** | `AsyncLock` that serializes all master-grid mutations to prevent races. |
| **`syncFromMaster()`** | WorkingGrid method that selectively syncs one order from the master into the working copy during fills, avoiding a full abort. |
| **Delta / COW Action** | A `{ type, id, ... }` object describing a single Create / Update / Cancel operation derived by comparing master vs. working grid. Only deltas are sent to the blockchain. |
| **Rebalance States** | `NORMAL → REBALANCING → BROADCASTING → NORMAL`. Fills during REBALANCING sync into working grid. Fills during BROADCASTING mark it stale. |

### Signal & Market Adapter Concepts

| Term | Meaning |
|------|---------|
| **Dynamic Weight** | Live buy/sell weight bias computed from AMA slope + Kalman confirmation + ATR volatility penalty |
| **Regime Detection** | Hurst Exponent + Permutation Entropy classification of market structure (trending, mean-reverting, noisy) |
| **Regime Table** | Signal-strength lookup table in `constants.ts` that dampens or preserves dynamic weight based on regime |
| **AMA Slope** | Filtered measure of AMA velocity used to derive directional weight offset |
| **Kalman Confirmation** | Kalman-filtered trend signal blended with AMA slope for smoother weight transitions |
| **Symmetric Shift** | Volatility-driven downward weight penalty applied equally to both sides (ATR-based) |
| **Asymmetric Offset** | Directional weight shift (buy-heavy or sell-heavy) driven by AMA/Kalman trend |
| **GridPrice** | Price anchor for grid math; can be numeric, `"pool"`, `"book"`, or AMA keyword (`"ama"`, `"ama1"`–`"ama4"`) |

### Grid Concepts

| Term | Meaning |
|------|---------|
| **Master Rail** | Unified array of price levels (not separate buy/sell rails) |
| **Boundary Index** | Pivot point separating BUY/SPREAD/SELL zones |
| **Spread Gap** | Buffer of empty slots between best buy and best sell |
| **Crawl Candidate** | Furthest active order eligible for rotation |
| **Shortage** | Empty slot in the active window that needs an order |
| **Surplus** | Order outside the active window that can be rotated |
| **Hard Surplus** | Order beyond the configured window + reserve (`coreOrders` + `edgeOrders`) count |
| **Reserve** | Edge-pinned live order outside the active window (buys at grid floor, sells at grid ceiling); never moves the boundary |
| **Dust** | Partial order < 5% of ideal size |
| **Dust Cancel** | Immediate on-chain cancel of dust partials on detection (no delay, no timer). Slot freed for a fresh counter-order. |

### Credit/Debt Runtime Concepts

| Term | Meaning |
|------|---------|
| **Debt Policy** | Per-bot configuration block (`debtPolicy.lending` array) governing borrowing behavior. Each item declares its own `collateralAsset`. |
| **MPA Borrow** | Market-pegged asset call-order update (debt-first CR planning) |
| **Credit Offer** | On-chain peer-to-peer lending offer acceptance and repayment |
| **Auto-Reborrow** | Bot-side flag allowing a new credit offer accept after successful repay |
| **CR Planner** | Shared collateral-ratio math layer in `modules/cr_planner.ts` |
| **Credit Runtime** | Bot-scoped executor in `modules/credit_runtime.ts` for debt operations and grid-reset requests |
| **LP-Backed Collateral** | Liquidity-pool share tokens used as collateral, valued from underlying reserves |

### Operations

| Term | Meaning |
|------|---------|
| **Rotation** | Moving an order from one price level to another |
| **Consolidation** | Absorbing surviving non-dust partials into ordinary fund-driven rebalancing. Detected dust is cancelled immediately and never waits for a rebuild. |
| **Rebalancing** | Adjusting order sizes based on current funds |
| **Global Side Capping** | Scaling order sizes when insufficient funds |
| **Atomic Check-and-Deduct** | Verify funds + deduct in single operation |
| **Divergence Detection** | Comparing ideal grid vs. persisted grid |
| **Invariant Verification** | Checking fund accounting consistency |
| **Batch Processing** | Grouping multiple fills into a single rebalance cycle instead of one-at-a-time. Gap-slot sizing: `<= gapSlots + 1` unified, otherwise chunked at `gapSlots + 1`. |
| **Gap-Slot Batch Sizing** | Deterministic chunking model with the grid gap-slot count + 1 as the per-broadcast bound. Keeps throughput high while avoiding tier-lookup complexity. |
| **Stale-Order Recovery** | Fast-path recovery for single-operation batches that encounter stale orders on-chain. Executes cleanup without full state sync. |
| **Orphan-Fill Prevention** | Deduplication mechanism that prevents double-crediting fills from stale-cleaned orders using timestamp-based ID tracking (TTL pruning). |

### Price Orientation and Derivation

**Critical Concept**: All prices in DEXBot2 use **B/A orientation** (how much of asset B per 1 unit of asset A).

| Term | Meaning | Example |
|------|---------|---------|
| **B/A Orientation** | Price format representing "how much B per 1 A" | XRP/BTS: 1350 means 1 XRP = 1350 BTS |
| **A/B Orientation** | Price format representing "how much A per 1 B" (NOT used in bot) | XRP/BTS: 0.00074 means 0.00074 XRP per 1 BTS |

#### Price Sources and Conversions

| Source | Raw Format | Conversion | Final Format |
|--------|-----------|-----------|-------------|
| **BitShares `get_order_book(A, B)`** | A/B (base/quote) | `1 / mid` | B/A ✓ |
| **BitShares `get_ticker(A, B)`** | A/B (base/quote) | `1 / value` | B/A ✓ |
| **Liquidity Pool Reserves** | `reserve_A / reserve_B` | `floatB / floatA` | B/A ✓ |

#### Implementation (`modules/order/utils/system.ts`)

**`deriveMarketPrice(BitShares, symA, symB)`**:
```javascript
// BitShares get_order_book(A, B) returns prices in A/B format
const mid = (bestBid + bestAsk) / 2;  // e.g., 0.00074 (XRP per BTS)
return 1 / mid;  // Convert to B/A: 1/0.00074 ≈ 1350 (BTS per XRP)
```

**`derivePoolPrice(BitShares, symA, symB)`**:
```javascript
// Pool reserves come from blockchain in order [reserve_A, reserve_B]
const floatA = safeBlockchainToFloat(amtA, aMeta.precision);
const floatB = safeBlockchainToFloat(amtB, bMeta.precision);
return floatB / floatA;  // Already B/A: 3000000 BTS / 20000 XRP = 150 (BTS/XRP)
```

#### Why This Matters

- **Grid Placement**: `startPrice` determines where BUY orders (below) and SELL orders (above) are placed
- **Consistency**: Both market and pool prices use B/A so they're directly comparable
- **Debugging**: Inverted prices cause bot to place orders on the wrong side of the market (e.g., massive sells when market rises)

#### Common Debugging Pattern

If you see prices like `0.000795` when expecting `1350`:
1. This is likely A/B format (raw from API)
2. Check if inversion (`1 / price`) is being applied
3. Verify which function is missing the conversion

---

## Precision & Quantization Best Practices

Floating-point arithmetic accumulates rounding errors across repeated price derivations, fund allocations, and order sizing. Always use the centralized quantization utilities in `modules/order/utils/math.ts` to eliminate accumulation.

### When to Quantize

| Situation | Use Function | Why |
|-----------|--------------|-----|
| **Calculating order sizes** | `quantizeFloat()` | Geometric weighting produces float errors; snap to satoshi precision |
| **Fund allocation** | `quantizeFloat()` | After dividing total by weights, accumulation errors occur |
| **Price derivations** | `quantizeFloat()` | Pool/market calculations prone to float drift |
| **Comparing sizes** | `normalizeInt()` | Ensure both values use same integer representation before == |
| **Validating blockchain match** | `normalizeInt()` | Check internal ≈ chain by normalizing both sides |

### Code Example: Correct vs Incorrect

```javascript
// ❌ WRONG - Float accumulation errors
const sizes = [];
const base = 0.995;
const totalFunds = 100.12345678;
for (let i = 0; i < 5; i++) {
    const weight = Math.pow(base, i);
    sizes.push((weight / sumWeights) * totalFunds);  // Drift accumulates!
}

// ✅ CORRECT - Quantized to precision
import { quantizeFloat } from '../order/utils/math';
const sizes = [];
const precision = 8;
const base = 0.995;
const totalFunds = 100.12345678;
for (let i = 0; i < 5; i++) {
    const weight = Math.pow(base, i);
    const size = (weight / sumWeights) * totalFunds;
    sizes.push(quantizeFloat(size, precision));  // Snap to satoshi
}
// Result: All sizes align to 8 decimal places, no drift
```

### Import Pattern

```javascript
import { quantizeFloat, normalizeInt } from '../order/utils/math';

// Quantize a float value (e.g., 45.123456789 → 45.12345679)
const correctedPrice = quantizeFloat(derivedPrice, 8);

// Normalize an integer (e.g., ensure consistency in comparisons)
const normalized = normalizeInt(currentSizeInt, assetPrecision);
```

**See [FUND_MOVEMENT_AND_ACCOUNTING.md § 5.5](FUND_MOVEMENT_AND_ACCOUNTING.md#55-precision--quantization) for complete quantization guide and edge case handling.**

---

## Export Surface & Test Seams

Three rules keep the module surface honest once you start narrowing it.

**1. Declaration emit is a real consumer.** A type used only inside its own module can still be unnameable from a dependent package's `.d.ts`. The claw wrapper infers `Promise<CredentialDaemonResponse>` from `modules/dexbot_credential_client.ts`, so de-exporting that interface broke `npm run build --prefix claw` with `TS4058` even though nothing imports it by name. Before narrowing an export, run `npm run build --prefix claw` as well as `npm run typecheck`; when a type must stay exported purely for emit, say so in its JSDoc.

**2. The shipped `dist/` is a public API.** The package publishes compiled JS plus declarations, so dropping an optional positional parameter is breaking even when every in-repo caller is updated (for example `calculateOrderSizes`, `calculateRotationOrderSizes` and `allocateFundsByWeights` lost their unused `minSize` arguments). The changelog is written at release time, so call the break out in the next release entry instead of leaving it implicit.

**3. Test-only helpers live in one `__test` object.** White-box helpers that only tests call are grouped as `export const __test = { ... }` instead of individual named exports, so a dead-export scan does not have to special-case them. Nothing outside the defining module may reference `__test` — `tests/test_public_surface_guard.ts` fails the suite if production code imports the seam or if it is touched more than once in its own module.

---

## Module Deep Dive

### OrderManager (`modules/order/manager.ts`)

**Role**: Central coordinator for all order operations

**Key Responsibilities**:
- Maintain **immutable** master grid (`orders` Map, frozen via `Object.freeze()`)
- Enforce Copy-on-Write rebalancing via `WorkingGrid` and atomic commits
- Coordinate specialized engines (Accountant, Strategy, Sync, Grid)
- Manage order indices for fast lookups
- Handle order locking to prevent race conditions

**Critical Methods**:
```javascript
// Central state update - ALWAYS use this, never modify orders Map directly
// Signature: _updateOrder(order, context = 'updateOrder', options = {})
_updateOrder(order, context, { skipAccounting, fee })

// COW rebalance pipeline
performSafeRebalance(fills, excludeIds)       // Entry point; delegates to COW
_applySafeRebalanceCOW(fills, excludeIds)     // Creates WorkingGrid, runs planning
_workingGrid.buildDelta(masterGrid)          // Computes actions vs master (utils/order.ts buildDelta)
_commitWorkingGrid(workingGrid, indexes, boundary, { skipRecalc }) // Atomic swap: working → master

// COW state tracking
_setRebalanceState(state)    // NORMAL | REBALANCING | BROADCASTING
_currentWorkingGrid          // Reference to active WorkingGrid (for fill sync)

// Fast lookups using indices
getOrdersByTypeAndState(type, state)

// Concurrency control
lockOrders([orderId])
unlockOrders([orderId])
isOrderLocked(orderId)

// Batch optimization
pauseFundRecalc()
resumeFundRecalc()
```

> **COW Rule**: The `orders` Map is frozen. Never call `manager.orders.set()` directly. All mutations go through `_applyOrderUpdate()` (for master changes) or the WorkingGrid (for planning). The master is only replaced inside `_commitWorkingGrid()` after blockchain success.

**Common Patterns**:
```javascript
// Pattern 1: Simple order state update (uses defaults)
manager._updateOrder({
    id: 'buy-5',
    state: ORDER_STATES.ACTIVE,
    type: ORDER_TYPES.BUY,
    price: 0.5,
    size: 100,
    orderId: '1.7.12345'
});

// Pattern 2: Update with context and fee (for blockchain operations)
manager._updateOrder(
    { id: 'buy-5', state: ORDER_STATES.VIRTUAL, orderId: null },
    'cancel-order',  // context for logging
    { skipAccounting: false, fee: 0 }  // update balances, no cancel fee
);

// Pattern 3: Batch updates with pause/resume
manager.pauseFundRecalc();
for (const order of orders) {
    manager._updateOrder(order, 'rebalance-batch', { skipAccounting: false, fee: 0 });
}
manager.resumeFundRecalc(); // Recalculates once at end

// Pattern 4: Safe async operations
manager.lockOrders([orderId]);
try {
    await chainOperation();
} finally {
    manager.unlockOrders([orderId]);
}
```

---

## Phantom Orders Prevention (Defense-in-Depth)

### Why This Matters

**Phantom orders** are orders that exist in memory as ACTIVE/PARTIAL state but lack a corresponding blockchain `orderId`. This causes fund tracking corruption:
- Memory shows orders locked in `committed.grid` but blockchain has no such orders
- Leads to "doubled funds" warnings where `trackedTotal >> blockchainTotal`
- Causes high RMS divergence with many unmatched orders
- Can lock funds indefinitely if not detected

### Three-Layer Prevention System

#### Layer 1: Primary Guard in `OrderManager._updateOrder()` (manager.ts)

**The Critical Validation**:
```javascript
// Centralized check - ALL state transitions go through here
if ((order.state === ORDER_STATES.ACTIVE || order.state === ORDER_STATES.PARTIAL) && !order.orderId) {
    logger.log(
        `ILLEGAL STATE: Refusing to set order ${id} to ${order.state} without orderId. ` +
        `Context: ${context}. This would create a phantom order that doubles fund tracking. ` +
        `Downgrading to VIRTUAL instead.`,
        'error'
    );
    order.state = ORDER_STATES.VIRTUAL;  // Auto-correct
}
```

**Why It Works**:
- Every order state change must call `_updateOrder()` (enforced throughout codebase)
- Cannot be bypassed - direct state assignments are not used for order state
- Applies to ALL modules: grid, sync, strategy, dexbot_class
- Auto-correction with logging provides audit trail

#### Layer 2: Grid Resize Protection (grid.ts)

**Before (Vulnerable)**:
```javascript
manager._updateOrder({ ...order, size: newSize, state: ORDER_STATES.ACTIVE }, 'grid-resize', ...);
```

**After (Safe)**:
```javascript
manager._updateOrder({ ...order, size: newSize, state: order.state }, 'grid-resize', ...);
```

**Why It Matters**: Preserves order's current state instead of forcing ACTIVE, preventing VIRTUAL → ACTIVE phantom creation during grid resizing.

#### Layer 3: Sync Cleanup (sync_engine.ts)

**Phantom Detection & Prevention**:
```javascript
// If order has no ID OR its ID is not on chain, it's a phantom/filled order
if (!currentGridOrder?.orderId || !parsedChainOrders.has(currentGridOrder.orderId)) {
    const spreadOrder = convertToSpreadPlaceholder(currentGridOrder);
    mgr._updateOrder(spreadOrder, 'sync-cleanup-phantom', ...);

    // CRITICAL: Only trigger fill processing for GENUINE fills (had orderId)
    // Phantoms (never had orderId) should NOT trigger rotations/rebalancing
    if (currentGridOrder?.orderId) {
        filledOrders.push({ ...currentGridOrder });
    }
}
```

**Why It Matters**:
- Detects phantoms on every sync
- Converts to SPREAD placeholders (releases locked funds)
- Prevents phantom fills from triggering unwarranted rotations/rebalancing

### Additional Hardening

**Strategy Module** (strategy.ts):
```javascript
// Only upgrade to ACTIVE if order has valid orderId
const newState = partial.orderId ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL;
```

**Fallback Placements** (dexbot_class.ts):
```javascript
const fallbackPlacements = unmetRotations.map(r => ({
    id: r.newGridId,
    price: r.newPrice,
    size: r.newSize,
    type: r.type,
    state: ORDER_STATES.VIRTUAL  // Start VIRTUAL, become ACTIVE after blockchain confirmation
}));
```

### Testing

See `tests/repro_phantom_orders.ts` for comprehensive test coverage:
- Direct phantom creation attempt (blocked)
- Grid resize phantom prevention (verified)
- Sync cleanup of orphaned ACTIVE orders (verified)
- Valid ACTIVE order preservation (verified)

---

## Copy-on-Write (COW) Development Rules

The COW architecture is the **single standard** for grid mutations. All new rebalancing code must follow these rules.

### The Golden Rule

> The master grid (`manager.orders`) is **read-only** for strategy code. Only `_applyOrderUpdate()` (internal) and `_commitWorkingGrid()` (COW commit) may replace it.

### Rebalance Pipeline (Required Pattern)

```javascript
// 1. Entry: performSafeRebalance() creates WorkingGrid automatically
//    → calls _applySafeRebalanceCOW(fills, excludeIds)

// 2. Planning: Work on the working copy ONLY
const workingGrid = new WorkingGrid(manager.orders, { baseVersion: manager._gridVersion });
workingGrid.set(orderId, updatedOrder);  // OK - modifies clone, not master

// 3. Broadcast: _updateOrdersOnChainBatchCOW() sends ops to chain
//    → On success: _commitWorkingGrid() atomically replaces master
//    → On failure: workingGrid discarded (master unchanged)
```

### What New Code Must NOT Do

```javascript
// ❌ WRONG: Direct master mutation
manager.orders.set('buy-5', order);             // Throws (frozen Map)
manager.orders.get('buy-5').size = 100;         // Throws (deepFrozen object)

// ❌ WRONG: Bypassing _applyOrderUpdate for blockchain-confirmed changes
manager.orders = new Map([...manager.orders]);  // Breaks version + index tracking

// ✅ CORRECT: State changes for confirmed blockchain events
manager._applyOrderUpdate(order, 'my-context'); // Updates master + increments version

// ✅ CORRECT: Planning changes during rebalance
workingGrid.set(orderId, newOrderState);         // Safe - working copy only
```

### Fill Handling During Rebalance

| COW State | Fill Arrives | Action |
|-----------|-------------|--------|
| `NORMAL` | Individual fill | Process immediately, update master |
| `REBALANCING` | Individual fill | Update master + `workingGrid.syncFromMaster(master, id)` |
| `BROADCASTING` | Individual fill | Update master + mark working grid stale; commit guard will reject |
| `REBALANCING`/`BROADCASTING` | Full side update | Block until fills = 0 or abort |

For full details see [COPY_ON_WRITE_MASTER_PLAN.md](COPY_ON_WRITE_MASTER_PLAN.md).

---

## Order State Helper Functions

**Location**: `modules/order/utils/order.ts`

**Purpose**: Single source of truth for order state logic, replacing 34+ inline checks scattered across the codebase.

**Benefit**: Semantic function names, centralized phantom detection, consistent patterns across all modules.

### Core State Checkers

#### `isOrderOnChain(order)`
```javascript
// Check if order exists on blockchain
// Returns true for ACTIVE or PARTIAL orders
if (isOrderOnChain(order)) {
    // Order has presence on blockchain
}
```

#### `isOrderVirtual(order)`
```javascript
// Check if order is planned but not yet placed
// Returns true for VIRTUAL orders
if (isOrderVirtual(order)) {
    // Order is reserved capital but not on-chain yet
}
```

#### `hasOnChainId(order)`
```javascript
// Check if order has a valid blockchain orderId
// Returns true if orderId is non-null and non-empty
if (hasOnChainId(order)) {
    // Order has been successfully placed and confirmed
}
```

#### `isOrderPlaced(order)`
```javascript
// Check if order is safely placed (on-chain with ID)
// Combines: state === ACTIVE/PARTIAL AND orderId exists
if (isOrderPlaced(order)) {
    // Safe to use in calculations requiring blockchain confirmation
}
```

#### `isPhantomOrder(order)`
```javascript
// Detect phantom orders (on-chain state without ID - error state)
// Returns true for ACTIVE/PARTIAL orders WITHOUT orderId
if (isPhantomOrder(order)) {
    // ERROR: This order shouldn't exist - fund tracking is corrupt
    logger.error(`Phantom order detected: ${order.id}`);
}
```

#### `isSlotAvailable(order)`
```javascript
// Check if slot can be reused (VIRTUAL + no ID)
// Returns true for VIRTUAL orders without orderId
if (isSlotAvailable(order)) {
    // Can overwrite this slot with a new order
}
```

### State Transition Helpers

#### `virtualizeOrder(order)`
```javascript
// Transition order to VIRTUAL state and clear blockchain metadata
// Preserves the order's type (BUY/SELL) and size — use when the order
// should remain pickable on its original rail (e.g. reservation keep).
const virtualizedOrder = virtualizeOrder(order);
// Result: {
//     ...order,
//     state: ORDER_STATES.VIRTUAL,
//     orderId: null,
//     filledSize: 0
// }
```

#### `convertToSpreadPlaceholder(order)`
```javascript
// Transition order to a side-neutral SPREAD placeholder.
// Zeroes size AND sets type to SPREAD — use when the slot becomes an
// empty reusable placeholder that may be activated on either rail.
const placeholder = convertToSpreadPlaceholder(order);
// Result: {
//     ...order,
//     state: ORDER_STATES.VIRTUAL,
//     type: ORDER_TYPES.SPREAD,
//     orderId: null,
//     size: 0
// }
```

### Order Health Validation

#### `isOrderHealthy(order, minSize)`
```javascript
// Comprehensive validation: size > 0 AND not dust-threshold
// Prevents undersized orders that cause blockchain failures
const minHealthySize = getMinOrderSize(ORDER_TYPES.BUY, assets, 1.0);
if (isOrderHealthy(order, minHealthySize)) {
    // Order is valid for placement/rotation
} else {
    // Order is dust - skip it here; cancelDustOrders() handles it on-chain
}
```

### Precision Helpers

#### `getPrecisionSlack(precision, factor)`
```javascript
// Calculate float comparison tolerance for given precision
// Location: modules/order/utils/math.ts
// Returns: factor * quantumForPrecision(precision) (factor defaults to 2)
const slack = getPrecisionSlack(5);  // Returns 2 * 10^-5 = 0.00002

// Use case: Floating-point safe comparisons
if (Math.abs(order.size - expected) <= slack) {
    // Sizes match within precision tolerance
}
```

**Eliminates duplications in**:
- `accounting.ts::recalculateFunds()`
- `manager.ts::_updateOrder()`

### Common Usage Patterns

**Pattern 1: Type-safe Order Placement**
```javascript
// Only place orders that are truly safe
const ordersToPlace = orders.filter(o =>
    isOrderHealthy(o, minSize) && !isOrderPlaced(o)
);
```

**Pattern 2: Phantom Detection During Sync**
```javascript
// Detect and cleanup phantoms during blockchain sync
for (const order of allOrders) {
    if (isPhantomOrder(order)) {
        const placeholder = convertToSpreadPlaceholder(order);
        mgr._updateOrder(placeholder, 'sync-cleanup-phantom', { skipAccounting: false, fee: 0 });
    }
}
```

**Pattern 3: Reusable Slot Identification**
```javascript
// Find slots available for overwriting
const reusableSlots = grid.filter(isSlotAvailable);
for (const slot of reusableSlots) {
    slot = createNewOrder(slot.index, newPrice);
}
```

---

### Accountant (`modules/order/accounting.ts`)

**Role**: Fund tracking and fee management

**Key Responsibilities**:
- Calculate available funds for each side
- Verify fund invariants
- Manage BTS transaction fees
- Atomic fund deduction

**Critical Methods**:
```javascript
// Master fund calculation - called after every state change
recalculateFunds()

// Atomic fund operations
tryDeductFromChainFree(orderType, size, operation)
addToChainFree(orderType, size, operation)

// Fee management
deductBtsFees(requestedSide)

// Safety checks
_verifyFundInvariants(mgr, chainFreeBuy, chainFreeSell, chainBuy, chainSell, actualBuy, actualSell)
```
 
 **Fund Calculation Flow**:
```javascript
// 1. Reset all fund pools
resetFunds()

// 2. Iterate all orders and accumulate
for (const order of orders) {
    if (order.state === VIRTUAL) {
        funds.virtual[side] += order.size
    } else if (order.state === ACTIVE || order.state === PARTIAL) {
        funds.committed.grid[side] += order.size
        if (order.orderId) {
            funds.committed.chain[side] += order.size
        }
    }
}

// 3. Calculate available
funds.available[side] = max(0, 
    chainFree - virtual - btsFeesOwed - btsFeesReservation
)

// 4. Verify invariants (signature: mgr, chainFreeBuy, chainFreeSell, chainBuy, chainSell, actualBuy, actualSell)
_verifyFundInvariants(...)
```
 
 ---
 
 ### StrategyEngine (`modules/order/strategy.ts`)

**Role**: Grid rebalancing and order rotation

**Key Responsibilities**:
- Process filled orders
- Identify shortages and surpluses
- Execute order rotations
- Handle surviving non-dust partials during rebalance

**Critical Methods**:
```javascript
// Pure target grid calculation — no side effects
calculateTargetGrid(params)

// Fill processing (fund updates only, no rebalance trigger)
processFillsOnly(filledOrders, excludeOrderIds)

// Dust detection
hasAnyDust(partials, side)
```

**Rebalancing Algorithm**:
```javascript
// 1. Determine reference price from fills or market
// 2. Calculate gap slots for spread zone
// 3. Determine split index (boundary location in sorted prices)
// 4. Assign roles: BUY below boundary, SPREAD within gap, SELL above
// 5. Calculate order sizes from budget
// 6. Return { targetGrid: Map, boundaryIdx: number }
```

---

### Grid (`modules/order/grid.ts`)

**Role**: Grid creation, sizing, and divergence detection

**Key Responsibilities**:
- Create geometric price grids
- Calculate spread gap size
- Detect grid divergence
- Update order sizes from blockchain

**Critical Methods**:
```javascript
// Create initial grid
createOrderGrid(config)

// Initialize with blockchain balances
initializeGrid(manager)

// Complete fund trigger: available-funds ratio + over-allocation + the
// on-chain committed-drift leg (closes the virtual-reservation blind spot)
checkAndUpdateGridIfNeeded(manager)

// Drift-only async accessor (refreshes funds first); its core is folded into
// checkAndUpdateGridIfNeeded above
checkCommittedSizeDrift(manager)

// Spread correction: plan-time dedupe + bounded fresh-master re-plan retry,
// wrapped in a held broadcast region (see architecture.md → Resilience)
checkSpreadCondition(manager, BitShares, batchCb)

// Compare ideal vs. persisted grid
compareGrids(calculatedGrid, persistedGrid, manager)
```

**Grid Creation Flow**:
```javascript
// 1. Calculate spread gap size
const stepFactor = 1 + (incrementPercent / 100);
const minSteps = MIN_SPREAD_FACTOR; // 2
const targetSteps = ceil(ln(1 + targetSpread/100) / ln(stepFactor));
const gapSlots = max(minSteps, targetSteps - 1); // Account for naturally occurring center gap

// 2. Generate price levels
const prices = [];
let price = startPrice;
for (let i = 0; i < totalLevels; i++) {
    prices.push(price);
    price *= stepFactor;
}

// 3. Assign roles based on boundary
for (let i = 0; i < prices.length; i++) {
    if (i <= boundaryIdx) {
        type = BUY;
    } else if (i <= boundaryIdx + gapSlots) {
        type = SPREAD;
    } else {
        type = SELL;
    }
}
```

---

### SyncEngine (`modules/order/sync_engine.ts`)

**Role**: Blockchain synchronization and fill detection

**Key Responsibilities**:
- Sync grid state with blockchain
- Detect filled orders
- Update account balances
- Match chain orders to grid orders

**Critical Methods**:
```javascript
// Main sync entry point
synchronizeWithChain(data, source)

// Sync from open orders
syncFromOpenOrders(openOrders, syncInfo)

// Sync from fill history
syncFromFillHistory(operation)

// Fetch account balances
fetchAccountBalancesAndSetTotals()
```

---

## Startup Sequence & Lock Ordering

### Unified Startup Flow

The bot startup has been consolidated into a shared sequence used by all entry points (`start()`, `startWithPrivateKey()`, CLI, PM2). This ensures identical behavior and eliminates maintenance burden from duplicate code.

#### Startup Phases (In Order)

```javascript
// Phase 1: Initialize state
_initializeStartupState()
  ├─ Verify account configuration
  └─ Load existing or generate new grid state

// Phase 2: Set up account context
_setupAccountContext()
  ├─ Resolve account ID
  ├─ Load fund balances
  └─ Initialize AccountOrders subscription

// Phase 3: Create order manager
// (OrderManager spawned with initial state)

// Phase 4: Run grid maintenance
_runGridMaintenance()
  ├─ Acquire _fillProcessingLock
  └─ Execute maintenance logic:
      ├─ Threshold check (cache ratio)
      ├─ Divergence check (if threshold fails)
      ├─ Spread check (out-of-spread recovery)
      └─ Health check (invariant verification)

// Phase 5: Finish startup
_finishStartupSequence()
  ├─ Mark bootstrap complete
  ├─ Begin fill processing
  └─ Start periodic maintenance timer
```

### Lock Ordering for Deadlock Prevention

**Critical Rule: Always acquire locks in ascending level order**

The canonical hierarchy (defined at `manager.ts`):

```
Level 0:   _fillProcessingLock  (fill processing — outermost)
Level 0.5: placement region     (exclusive chain-mutation mutex — PlacementLock)
Level 1:   _divergenceLock      (divergence checks)
Level 2:   _syncLock            (sync operations — timeout-protected)
Level 3:   _gridLock            (grid mutations)
Level 4:   _fundLock            (fund operations — innermost)
```

All levels live on the `OrderManager` instance (the placement region is
`_placementLock`, see `modules/order/placement_lock.ts`). The `level` property
is a convention marker — AsyncLock does not enforce it at runtime, and
`PlacementLock` is not an AsyncLock (it is a FIFO, non-reentrant lease).

**Placement region (Level 0.5)** serializes every chain-mutating path: COW
broadcasts, reconcile Phase 1+2, correction drains, dust/residual cancels and
pool swaps. It is acquired **before** `_gridLock` and never while holding it,
and it is `NOT` reentrant — nested work receives the holder's lease instead of
acquiring again, and verifies it with `manager.isPlacementLeaseCurrent(lease)`
(`isPlacementActive()` is true for ANY holder and must not be used for that).
The canonical region order is:
`startBroadcasting → placement → gridLock → fundLock → release placement → stopBroadcasting`.
A leaked region is force-released by `_clearStalePlacementRegion()`, which also
drops the hung region's stale broadcast refcount in the same step.

**Why This Order?**

- Fill processing (Level 0) is the most frequent operation (high contention) — outermost so it serializes all inner work
- Divergence checks (Level 1) nest inside fill processing
- Sync operations (Level 2) are acquired before grid mutations — the timeout-protected lock is inner, so a stuck sync releases the outer lock
- Grid mutations (Level 3) and fund operations (Level 4) are innermost
- The placement region (Level 0.5) sits between fill processing and the grid
  locks: it is broader than one grid mutation (it spans plan → broadcast →
  commit) but must never be taken while a grid lock is held
- All paths follow the same order

**`adjustTotalBalance` Locking Contract** (v1.4.7):

The public `adjustTotalBalance()` (Level 4) is now async and **acquires `_fundLock` internally**. Callers that already hold `_fundLock` (e.g. the fee-settlement paths inside `modules/order/accounting.ts`) must use the private `_adjustTotalBalanceLocked()` sync helper instead to avoid redundant nested re-entrancy. Callers outside any `_fundLock` region (e.g. `_applyBalanceAdjustments`, rollback, and the maintenance/sync/cow-runtime call sites) should continue using `adjustTotalBalance()` with `await`.

**Example: Safe Pattern**

```javascript
// ✅ CORRECT: Fill lock acquired, then divergence lock
async processFill(fill) {
    await this._fillProcessingLock.acquire();
    try {
        // Do fill processing...

        // If divergence check needed:
        await this._divergenceLock.acquire();
        try {
            // Check divergence...
        } finally {
            this._divergenceLock.release();
        }
    } finally {
        this._fillProcessingLock.release();
    }
}

// ❌ WRONG: Would deadlock if fill arrives during divergence check
async checkDivergence() {
    await this._divergenceLock.acquire();  // Level 1 without Level 0!
    try {
        // ...
    }
}
```

**Lock Scope in Startup**

The startup sequence uses a re-entrant async lock to ensure atomic operations. `AsyncLock` is re-entrant, so nested `acquire()` from within the same execution context runs the callback directly instead of queueing:

```javascript
async _runGridMaintenance() {
    await this._fillProcessingLock.acquire();
    try {
        // All maintenance operations run atomically
        // Fills cannot arrive mid-startup
    } finally {
        this._fillProcessingLock.release();
    }
}
```

**Bootstrap Flag Safety**

The `isBootstrapping` flag is guaranteed to be cleared using try-finally:

```javascript
async start() {
    manager.startBootstrap();
    try {
        // All startup phases...
    } finally {
        manager.finishBootstrap();  // Always cleared, even on error
    }
}
```

### Zero-Amount Order Prevention

All new orders pass through two validation gates:

1. **Strategy/Grid Logic** (`strategy.ts`, `grid.ts`, `utils/validate.ts`):
   - Check: `size >= getMinOrderSize(type, assets, factor)`
   - Double-dust threshold: `size >= getDoubleDustThreshold(idealSize, dustThresholdPercent)` (`utils/validate.ts` `isCreateHealthy`)
   - Prevents undersized placement attempts

2. **Broadcast Validation** (`dexbot_class.ts`):
   - Check: `amount > 0` for each order
   - Rejects zero-amount operations before blockchain transmission
   - Triggers recovery sync on validation failure

**Recovery from Failed Batches**

If a batch broadcast fails, the bot performs recovery:

```javascript
try {
    await broadcastBatch(orders);  // Broadcasting
} catch (error) {
    // Fresh balance fetch resets optimistic drift
    await this.manager.fetchAccountTotals(this.accountId);

    // Full sync aligns grid with blockchain reality
    const openOrders = await chainOrders.readOpenOrders(this.accountId);
    await this.manager.syncFromOpenOrders(openOrders, { skipAccounting: true });
}
```

---

## Managing Bot Configuration

### The `bots.json` Source of Truth

The bot's operational parameters are defined in `profiles/bots.json`. While most settings are loaded at startup, the system is designed to pick up manual changes to critical valuation parameters during its runtime.

#### Handling `startPrice`

The `startPrice` is the anchor for valuation (calculating the relative value of Asset A and Asset B). It can be configured in three ways:

1.  **Fixed Numeric Price** (e.g., `105.5`):
    *   The bot treats this as a **fixed anchor**.
    *   Automatic price derivation from the market is **disabled**.
    *   Used as the base for all grid math during a **Grid Reset**.

2.  **"pool"**:
    *   The bot fetches the current BitShares Liquidity Pool price.
    *   Updated periodically every 4 hours.
    *   Optional `poolRef` field pins the pool directly (e.g. `"poolRef": "1.19.48"`), bypassing pool discovery. Useful when the trading pair has no native pool — the bot prices from a proxy pool instead.

3.  **"book"**:
    *   The bot derives the price from the current order book.
    *   Updated periodically every 4 hours.

### Numeric `startPrice` - Fixed Anchor

When you set a **numeric value** like `"startPrice": 105.5` in `bots.json`:

**Behavior**:
- ✅ Auto-refresh is **DISABLED** - numeric value is treated as absolute anchor
- ✅ Grid valuation uses this fixed price for all calculations
- ✅ Grid remains stable during market moves (fund-driven rebalancing only)
- ❌ Auto-derivation never happens - market/pool price is ignored

**Use Case**: You want absolute control over grid positioning regardless of current market conditions.

### Runtime Updates (The 4h Refresh)

The bot performs a **Periodic Configuration Refresh** (every 4 hours by default).

**For Dynamic Pricing** (`startPrice: "book"` or `startPrice: "pool"`):
*   **Valuation Update**: Fetches latest market/pool price and updates grid anchor
*   **Grid Reposition**: Subsequent grid resets use updated valuation
*   **Operational Stability**: During normal operation, the bot remains "fund-driven" and doesn't move orders on-chain

**For Numeric Pricing** (`startPrice: 105.5`):
*   **No Changes**: Fixed value is never updated
*   **Valuation locked**: All calculations use the configured numeric value
*   **Manual Override Required**: To change numeric anchor, edit `bots.json` and use the bot's reset trigger file.

*   **Applying Changes**: To force the bot to move orders to a new `startPrice` immediately, create `profiles/recalculate.<botKey>.trigger` to perform a full grid reset. Empty or malformed trigger files are treated as manual/legacy resets; for AMA bots the runtime refreshes `gridCenterPrice` from the latest `amaCenterPrice` before rebuilding.

---

## Debt Policy Configuration

Bots can declare a `debtPolicy` block for native MPA and credit-offer workflows.

### Example `debtPolicy`

```json
{
  "name": "credit-bot-1",
  "debtPolicy": {
    "lending": [
      {
        "asset": "HONEST.USD",
        "collateralAsset": "BTS",
        "type": "mpa",
        "maxBorrowAmount": 1000,
        "maxCollateralAmount": 25000,
        "minCollateralRatio": 2.0,
        "maxCollateralRatio": 2.5,
        "targetCollateralRatio": 2.2,
        "minCollateralIncreaseThreshold": 5
      },
      {
        "asset": "HONEST.CNY",
        "collateralAsset": "BTS",
        "type": "creditOffer",
        "allowedOfferIds": ["1.18.42"],
        "disallowedDealIds": ["1.22.5", "1.22.12"],
        "maxBorrowAmount": 1000,
        "maxCollateralAmount": 25000,
        "maxFeeRatePerDay": 0.001,
        "maxCollateralRatio": 2.5,
        "minCollateralIncreaseThreshold": "5%",
        "autoReborrow": true,
        "autoRepay": 2
      }
    ]
  }
}
```

### Key Rules
- No separate runtime switch — active when `debtPolicy.lending` is present, non-empty, and each item declares `collateralAsset`
- Credit and MPA checks run from the dedicated credit watchdog interval
- Every successful CR adjustment triggers a grid rebuild via `requestGridReset()`
- Runtime policy enforces `maxFeeRatePerDay`, `maxCollateralRatio`, `allowedOfferIds`, `disallowedDealIds` (reborrow only), `maxBorrowAmountPerOperation` (per-op cap with oversized-deal splitter), and allowed assets before broadcasting
- **Collateral switching**: Changing `lendingItem.collateralAsset` on a `creditOffer` item causes the proactive expiry reborrow to switch the deal's collateral to the new asset (requires the offer to accept it). MPA collateral is fixed.
- Full usage details live in [MPA and Credit Usage](MPA_CREDIT_USAGE.md)

---

## How to Add New Features

### Example: Adding a New Order Type

**1. Update Constants**
```javascript
// modules/constants.ts
ORDER_TYPES: {
    BUY: 'buy',
    SELL: 'sell',
    SPREAD: 'spread',
    LIMIT: 'limit'  // NEW
}
```

**2. Update Manager Indices**
```javascript
// modules/order/manager.ts - constructor
this._ordersByType = {
    [ORDER_TYPES.BUY]: new Set(),
    [ORDER_TYPES.SELL]: new Set(),
    [ORDER_TYPES.SPREAD]: new Set(),
    [ORDER_TYPES.LIMIT]: new Set()  // NEW
};
```

**3. Update Fund Calculation**
```javascript
// modules/order/accounting.ts - recalculateFunds()
for (const order of orders.values()) {
    if (order.type === ORDER_TYPES.LIMIT) {
        // Handle new type
        funds.committed.grid[order.side] += order.size;
    }
}
```

**4. Update Strategy Logic**
```javascript
// modules/order/strategy.ts - rebalance()
const limitOrders = manager.getOrdersByTypeAndState(ORDER_TYPES.LIMIT, null);
// Process limit orders...
```

**5. Add Tests**
```javascript
// tests/test_manager_logic.ts
const assert = require('assert');

async function runTests() {
    console.log(' - Testing LIMIT order type tracking...');

    // Test: should track LIMIT orders in indices
    {
        const manager = createManager();
        await manager._updateOrder({
            id: 'limit-1',
            state: ORDER_STATES.VIRTUAL,
            type: ORDER_TYPES.LIMIT,
            size: 100,
            price: 50
        });
        const limitOrders = manager.getOrdersByTypeAndState(ORDER_TYPES.LIMIT, null);
        assert.strictEqual(limitOrders.length, 1, 'LIMIT order should be tracked in indices');
    }

    console.log('LIMIT order type tests passed.');
}

runTests();
```

**6. Update Documentation**
```markdown
// docs/architecture.md
### Order Types
- **LIMIT**: User-defined limit orders outside the grid
```

**7. Ensure COW Compliance**
- Any new strategy or rebalancing logic must operate on a `WorkingGrid`, not `manager.orders` directly.
- New blockchain-confirmed state updates must go through `_applyOrderUpdate()`.
- If a new operation can race with fills, verify the rebalance state (`_setRebalanceState`) gates it correctly.
- Add tests for master-unchanged-on-failure and commit-only-on-success scenarios.

---

## Testing Strategy

### Test Files
Located in `tests/` (with `helpers/` subdirectory):
- `test_accounting_logic.ts` - Fund calculation and accounting tests
- `test_grid_logic.ts` - Grid creation, sizing, and divergence tests
- `test_manager.ts` / `test_manager_logic.ts` - State management and COW tests
- `test_sync_logic.ts` - Blockchain synchronization tests
- `test_strategy_logic.ts` - Rebalancing and rotation logic
- `test_bts_fee_logic.ts` - BTS fee deduction and settlement
- `test_market_adapter_signal_gates.ts` - Market adapter signal validation
- `test_dynamic_weight_override_wiring.ts` - Dynamic weight config wiring
- `test_cr_planner.ts` - Collateral ratio planner tests
- `test_dexbot_credit_wiring.ts` - Credit runtime integration tests
- `test_credential_daemon.ts` / `test_credential_session_cache.ts` - Credential security tests

**Run tests**:
```bash
npm test
```

### Manual Verification

**1. Fund Invariant Check**
```javascript
// After any operation
manager.accountant._verifyFundInvariants(
    manager,
    chainFreeBuy,
    chainFreeSell,
    chainBuy,
    chainSell,
    mgr.accountTotals?.buy,
    mgr.accountTotals?.sell
);
```

**2. Index Consistency Check**
```javascript
// Index caches invalidate automatically via _gridVersion bumps — no manual
// validation/repair API exists. For structural checks (e.g. in tests):
assertOrdersStructurallySound(manager);  // tests/helpers/order_test_helpers.ts
```

**3. Grid Diagnostics**
```javascript
// After fills or rotations — use logFundsStatus for structured fund/order summaries
manager.logger.logFundsStatus(manager, 'AFTER FILL');
```

---

## Code Style Guidelines

### 0. **Respect the COW Boundary**
```javascript
// ✅ CORRECT - Planning on working copy (during rebalance)
workingGrid.set(orderId, { ...order, size: newSize });

// ✅ CORRECT - Confirmed blockchain event goes through _updateOrder()
manager._updateOrder({ ...order, state: ORDER_STATES.ACTIVE }, 'placed');

// ❌ WRONG - Direct master mutation (throws: Map is frozen)
manager.orders.set(orderId, order);
```

### 1. **Always Use _updateOrder()**
```javascript
// ✅ CORRECT - Uses proper signature with context
manager._updateOrder({
    id: 'buy-5',
    state: ORDER_STATES.ACTIVE,
    type: ORDER_TYPES.BUY,
    price: 0.5,
    size: 100
}, 'order-update', { skipAccounting: false, fee: 0 });

// ✅ ALSO CORRECT - Using defaults (context='updateOrder', options={})
manager._updateOrder({
    id: 'buy-5',
    state: ORDER_STATES.ACTIVE,
    type: ORDER_TYPES.BUY,
    price: 0.5,
    size: 100
});

// ❌ WRONG - Breaks indices
manager.orders.set('buy-5', order);
```

### 2. **Batch Fund Recalculation**
```javascript
// ✅ CORRECT - Recalculates once, with context for logging
manager.pauseFundRecalc();
for (const order of orders) {
    manager._updateOrder(order, 'rebalance-batch', { skipAccounting: false, fee: 0 });
}
manager.resumeFundRecalc();

// ⚠️ ACCEPTABLE - Uses defaults but less ideal for debugging
manager.pauseFundRecalc();
for (const order of orders) {
    manager._updateOrder(order);
}
manager.resumeFundRecalc();

// ❌ WRONG - Recalculates N times
for (const order of orders) {
    manager._updateOrder(order); // Triggers recalc each time
}
```

### 3. **Lock During Async Operations**
```javascript
// ✅ CORRECT
manager.lockOrders([orderId]);
try {
    await chainOperation();
} finally {
    manager.unlockOrders([orderId]);
}

// ❌ WRONG - Race condition possible
await chainOperation();
```

### 4. **Use Atomic Fund Operations**
```javascript
// ✅ CORRECT
if (manager.accountant.tryDeductFromChainFree(type, size)) {
    // Funds deducted atomically
    placeOrder();
} else {
    // Insufficient funds
}

// ❌ WRONG - Race condition
if (manager.funds.available[type] >= size) {
    manager.funds.available[type] -= size; // Not atomic!
    placeOrder();
}
```

---

## Performance Tips

### 1. **Use Index Lookups**
```javascript
// ✅ FAST - O(1) lookup
const activeBuys = manager.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE);

// ❌ SLOW - O(n) iteration
const activeBuys = Array.from(manager.orders.values())
    .filter(o => o.type === ORDER_TYPES.BUY && o.state === ORDER_STATES.ACTIVE);
```

### 2. **Batch Operations**
```javascript
// ✅ EFFICIENT - One recalc
manager.pauseFundRecalc();
// ... many updates ...
manager.resumeFundRecalc();

// ❌ INEFFICIENT - N recalcs
// ... many updates without pausing ...
```

### 3. **Cache Blockchain Calls**
```javascript
// ✅ GOOD - Uses fee cache (no amount = returns fee info object)
const feeInfo = getAssetFees('BTS');
console.log(feeInfo.createFee, feeInfo.updateFee);

// ✅ GOOD - With amount = returns net proceeds (number)
const netProceeds = getAssetFees('IOB.XRP', 100);

// ❌ BAD - Fetches every time
const fees = await BitShares.db.get_global_properties();
```

### 4. **Leverage Pool ID Caching**

When deriving pool prices, the bot caches Liquidity Pool IDs to avoid repeated blockchain scans.

```javascript
// ✅ GOOD - Uses cached pool IDs
const price = await derivePoolPrice(assetA.symbol, assetB.symbol);
// First call: scans blockchain for pool
// Subsequent calls: uses cached ID if assets match

// Smart fallback: Cache miss triggers fresh scan
if (cachedPoolId.assets !== requestedAssets) {
    // Cache invalidated - rescan blockchain
    const newPoolId = await scanBlockchainForPool(assetA, assetB);
}

// ✅ Transparent: No manual cache management needed
```

**How It Works**:
- Cache validated against requested assets before use
- Stale pool IDs automatically detected and refreshed
- Concurrent access safe via lock protection

**Performance Impact**:
- Eliminates redundant blockchain scans during startup and config refresh
- Particularly effective during periodic 4-hour price refresh cycles

### 5. **Pin a Pool with `poolRef`**

When a trading pair has no native liquidity pool (e.g. `BTS/XBTSX.USDC`), set `poolRef` in `bots.json` to pin a proxy pool for price derivation:

```json
{
  "name": "BTS-USDC",
  "assetA": "BTS",
  "assetB": "XBTSX.USDC",
  "startPrice": "pool",
  "poolRef": "1.19.48",
  "gridPrice": "ama1"
}
```

The decorator (`withPoolRef`) intercepts pool price queries and fetches the pinned pool directly by ID via `get_objects`, bypassing all discovery, caching, and the `poolIdCache`. The ID can be a full form (`"1.19.48"`) or a short suffix (`"48"`). When unset, the original discovery path runs unchanged — zero overhead.

---

## Common Pitfalls

### 1. **Forgetting to Unlock Orders**
```javascript
// ❌ BAD - Lock never released if error
manager.lockOrders([id]);
await operation(); // Might throw
manager.unlockOrders([id]); // Never reached

// ✅ GOOD - Always unlocks
manager.lockOrders([id]);
try {
    await operation();
} finally {
    manager.unlockOrders([id]);
}
```

### 2. **Direct Map Modification**
```javascript
// ❌ BAD - Breaks indices
manager.orders.set(id, order);

// ✅ GOOD - Updates indices
manager._updateOrder(order);
```

### 3. **Ignoring State Transition Rules**
```javascript
// ❌ BAD - Invalid transition
order.state = ORDER_STATES.VIRTUAL; // Was PARTIAL
manager._updateOrder(order); // Error logged

// ✅ GOOD - Valid transition
order.state = ORDER_STATES.ACTIVE; // PARTIAL → ACTIVE is valid
manager._updateOrder(order);
```

### 4. **Not Checking Lock Status**
```javascript
// ❌ BAD - Might process locked order
processOrder(order);

// ✅ GOOD - Skip if locked
if (!manager.isOrderLocked(order.id)) {
    processOrder(order);
}
```

---

## Useful Debugging Commands

### Enable Debug Logging
```javascript
manager.logger.level = 'debug';
```

### View Fund Status
```javascript
manager.logger.logFundsStatus(manager, 'CONTEXT');
```

### View Metrics
```javascript
console.log(dexbot.getMetrics());  // OrderManager._metrics plus live pipeline state
```

### Check Order Map Integrity
```javascript
// Structural check (tests); index caches self-invalidate via _gridVersion
assertOrdersStructurallySound(manager);
```

### Check Specific Order
```javascript
const order = manager.orders.get('buy-5');
console.log('State:', order.state);
console.log('Type:', order.type);
console.log('Locked?', manager.isOrderLocked(order.id));
```

---

## Resources

### Documentation
- [Architecture](architecture.md) - System design and module relationships
- [Copy-on-Write Master Plan](COPY_ON_WRITE_MASTER_PLAN.md) - COW architecture, phases, state machine, and test results
- [COW Invariants](COW_INVARIANTS.md) - Stable theory contract for COW pipeline
- [Fund Movement Logic](FUND_MOVEMENT_AND_ACCOUNTING.md) - Algorithms and formulas
- [Market Adapter](../market_adapter/README.md) - Signal pipeline and AMA integration
- [MPA and Credit Usage](MPA_CREDIT_USAGE.md) - MPA and credit offer workflows
- [README](../README.md) - User documentation
- [WORKFLOW](WORKFLOW.md) - Git branch workflow

### Code Entry Points
- `dexbot.ts` - CLI entry point
- `modules/dexbot_class.ts` - Core bot class
- `modules/dexbot_fill_runtime.ts` - Fill processing runtime
- `modules/dexbot_maintenance_runtime.ts` - Maintenance runtime
- `modules/order/manager.ts` - Order management hub

### Key Modules

**Order Management** (`modules/order/`):
- `manager.ts` - Order lifecycle and state management
- `accounting.ts` - Fund tracking
- `strategy.ts` - Rebalancing logic
- `grid.ts` - Grid creation
- `grid_reconcile.ts` - Startup grid reconciliation ([docs](GRID_RECONCILE.md))
- `grid_reconcile_internal.ts` - Internal grid reconciliation helpers
- `sync_engine.ts` - Blockchain sync
- `logger.ts` - Order logging
- `working_grid.ts` - COW working copy (clone/delta/commit)
- `processed_fill_store.ts` - Fill dedupe persistence
- `utils/order.ts` - Order state predicates and helpers
- `utils/math.ts` - Precision, quantization, fund math
- `utils/validate.ts` - Validation and COW action building
- `utils/system.ts` - Price derivation, deduplication

**Core Bot & Blockchain**:
- `modules/dexbot_class.ts` - Core bot class, lifecycle orchestration, shared runtime wiring
- `modules/dexbot_fill_runtime.ts` - Fill processing runtime and replay-safe accounting
- `modules/dexbot_maintenance_runtime.ts` - Sync loops, grid maintenance, trigger handling
- `modules/constants.ts` - Centralized configuration and tuning parameters
- `modules/bitshares_client.ts` - BitShares connection and node management
- `modules/node_manager.ts` - Multi-node health checking and failover
- `modules/fund_registry.ts` - Shared-account fund registry with cross-bot invariants
- `modules/settings_merge.ts` - Consolidated settings merge (single source of truth)
- `modules/bot_defaults.ts` - Central bot-defaults seeder (draft/entry/runtime-config modes); single source for how `DEFAULT_CONFIG` is applied
- `modules/chain_orders.ts` - Blockchain order operations
- `modules/account_orders.ts` - Account order queries

**Credit & Market Adapter**:
- `modules/credit_runtime.ts` - Debt workflow executor (MPA and credit offer)
- `modules/cr_planner.ts` - Collateral ratio math layer
- `market_adapter/core/market_adapter_service.ts` - Signal pipeline (AMA, dynamic weights)
- `market_adapter/market_adapter.ts` - AMA delta threshold, grid price offset, recalc triggers

**Claw Integration** (`claw/`):
- `claw/index.ts` - Main export combining all claw modules
- `claw/modules/chain_actions.ts` - Chain operations (reads/writes/broadcast)
- `claw/modules/chain_queries.ts` - Blockchain queries
- `claw/modules/chain_broadcast.ts` - Broadcast layer
- `claw/modules/claw_bridge.ts` - JSON bridge + command dispatch
- `claw/modules/claw_launcher.ts` - Launcher orchestration (PM2, Docker)
- `claw/modules/dexbot_bridge.ts` - DEXBot2 integration bridge
- `claw/modules/credit_runtime_adapter.ts` - Credit runtime lifecycle bridge
- `claw/modules/position_manager.ts` - Position tracking and health
- `claw/modules/short_mpa_strategy.ts` - High-level MPA strategy

---

## Testing Fund Calculations

Fund calculations are critical to system stability. This section covers how the test suite validates fund logic and how to add tests for new features.

### What Gets Tested

The test suite validates the following fund-related behaviors:

**Order State Transitions:**
```javascript
✓ VIRTUAL → ACTIVE → PARTIAL lifecycle
✓ Fund movement between pools during transitions
✓ Index consistency during state changes
✓ Invariant preservation during transitions
```

**Fund Pool Integrity:**
```javascript
✓ virtual.buy + virtual.sell = sum of all VIRTUAL orders
✓ committed.chain.buy = sum of ACTIVE orders with orderId
✓ committed.grid.buy = sum of ACTIVE + PARTIAL orders
✓ available.buy = max(0, chainFree - virtual - cache - fees)
```

**Critical Invariants:**
```javascript
✓ Invariant 1: chainTotal = chainFree + chainCommitted
✓ Invariant 2: available ≤ chainFree
✓ Invariant 3: gridCommitted ≤ chainTotal
```

**Edge Cases:**
```javascript
✓ Zero-size orders
✓ Very large orders (precision handling)
✓ Multiple concurrent state changes (atomicity)
✓ Fund deductions and additions
```

### Running Tests

```bash
# All tests (native assert)
npm test

# Specific logic area
node dist/tests/test_accounting_logic.js

# Specific integration test
node dist/tests/test_fills.js
```

### Understanding Test Structure

Tests use a consistent pattern for fund validation. They use native `assert` with `console.log` blocks (no Jest dependency):

```javascript
const assert = require('assert');
async function runTests() {
    console.log(' - Testing virtual funds from VIRTUAL orders...');

    // Setup manager with known initial state
    const manager = new OrderManager(config);
    await manager.setAccountTotals({ buy: 10000, sell: 100 });
    manager.resetFunds();

    {
        // Add VIRTUAL order
        await manager._updateOrder({
            id: 'virtual-1',
            state: ORDER_STATES.VIRTUAL,
            type: ORDER_TYPES.BUY,
            size: 500,
            price: 100
        });

        // Assert fund pool updated
        assert.strictEqual(manager.funds.virtual.buy, 500);
        assert(manager.funds.total.grid.buy >= 500);
    }

    console.log('Virtual funds tests passed.');
}
```

### Key Test Files

| File | Purpose |
|------|---------|
| `tests/test_strategy_logic.ts` | Rebalancing, placement, rotation |
| `tests/test_accounting_logic.ts` | Fund tracking, fees, precision |
| `tests/test_grid_logic.ts` | Grid creation, sizing, divergence |
| `tests/test_manager_logic.ts` | State machine, indexing |
| `tests/test_sync_logic.ts` | Blockchain reconciliation | Startup reconcile is `tests/test_grid_reconcile*.ts` |

### Adding Tests for Fund-Related Features

When adding features that affect funds, follow this checklist:

**1. Identify Fund Impact**
```javascript
// What fund pools are affected?
// - virtual (VIRTUAL orders)
// - committed.chain (ACTIVE orders with orderId)
// - committed.grid (ACTIVE + PARTIAL orders)
// - available (available pool)
// - available (spending power)
```

**2. Create Test Case**
```javascript
console.log(' - Testing [action] updates [fund pool]...');
{
    // Setup
    const initialFunds = manager.funds[poolName][side];

    // Action
    await performAction();

    // Assert
    const finalFunds = manager.funds[poolName][side];
    assert.strictEqual(finalFunds, expectedValue);
    assertOrdersStructurallySound(manager);  // Order Map structurally sound?
}
```

**3. Verify Invariants**
```javascript
// After your action, verify invariants
assert(
    manager.funds.total.chain.buy ===
    manager.funds.chainFree.buy + manager.funds.committed.chain.buy
);
```

**4. Test Edge Cases**
```javascript
// Test with:
✓ Zero funds available
✓ Very large orders (precision)
✓ Multiple concurrent updates
✓ State transitions
```

### Common Test Patterns

**Pattern 1: Batch Fund Updates**
```javascript
manager.pauseFundRecalc();  // Batch mode
await manager._updateOrder(order1, 'test-batch', { skipAccounting: false, fee: 0 });
await manager._updateOrder(order2, 'test-batch', { skipAccounting: false, fee: 0 });
await manager._updateOrder(order3, 'test-batch', { skipAccounting: false, fee: 0 });
manager.resumeFundRecalc();  // Recalc once

// Verify final state
assert.strictEqual(manager.funds.total.grid.buy, order1.size + order2.size + order3.size);
```

**Pattern 2: Fund Transitions**
```javascript
// VIRTUAL → ACTIVE
await manager._updateOrder({
    id: 'order-1',
    state: ORDER_STATES.VIRTUAL,
    size: 500,
    price: 100
}, 'test-setup');

const virtualBefore = manager.funds.virtual.buy;

await manager._updateOrder({
    id: 'order-1',
    state: ORDER_STATES.ACTIVE,
    orderId: 'chain-001',
    size: 500,
    price: 100
}, 'test-transition');

// Verify movement
assert(manager.funds.virtual.buy < virtualBefore);
assert(manager.funds.committed.chain.buy > 0);
```

**Pattern 3: Atomicity Check**
```javascript
// Verify operation is atomic (no partial state)
manager.lockOrders(['order-1']);
try {
    // Perform operation
    await fundDependentOperation();
    // Check state consistency
    assertOrdersStructurallySound(manager);
} finally {
    manager.unlockOrders(['order-1']);
}
```

### Recent Test Coverage

The test suite provides comprehensive coverage of fund calculations and rebalancing logic:

**Key Areas Tested:**
- ✅ VIRTUAL order placement with zero available pool
- ✅ PARTIAL order updates during rebalancing
- ✅ Grid divergence detection with stale cache
- ✅ BoundaryIdx persistence and recovery
- ✅ BUY side geometric weighting
- ✅ Real-time commitment accounting (CacheFunds removed)
- ✅ Rotation completion and skip prevention
- ✅ Fee calculation with isMaker parameter
- ✅ Market and blockchain taker fees
- ✅ Fund precision and delta validation

**Running Tests**:
```bash
# Test strategy rebalancing
node dist/tests/test_strategy_logic.js

# Test grid divergence
node dist/tests/test_grid_logic.js

# Test accounting precision
node dist/tests/test_accounting_logic.js

# Run full suite
npm test
```

See [tests/README.md](../tests/README.md) for detailed test coverage documentation.

### Debugging Fund Issues in Tests

If a test fails due to fund calculation issues:

```javascript
// 1. Print fund state
console.log('Fund state:', JSON.stringify(manager.funds, null, 2));

// 2. Check invariants
console.log('Invariants valid?', manager.accountant._verifyFundInvariants(
    manager,
    ...values
));

// 3. Trace order state
manager.orders.forEach(order => {
    console.log(`Order ${order.id}: state=${order.state}, size=${order.size}`);
});

// 4. Check index consistency
assertOrdersStructurallySound(manager);  // throws if any order entry is corrupt

// 5. Examine specific fund pool
console.log('Virtual buy:', manager.funds.virtual.buy);
console.log('Committed buy:', manager.funds.committed.grid.buy);
console.log('Available buy:', manager.funds.available.buy);
```

---

## Getting Help

### Common Questions

**Q: Where do I start reading the code?**  
A: Follow the Code Reading Roadmap above, starting with `constants.ts` and `manager.ts`.

**Q: How do I debug fund issues?**  
A: Use `manager.logger.logFundsStatus(manager)` and check invariants with `_verifyFundInvariants()`.

**Q: Why is my order not rotating?**  
A: Check if it's locked (`isOrderLocked()`), in exclusion list, or below dust threshold.

**Q: How do I add a new feature?**  
A: Follow the "How to Add New Features" section above.

**Q: Where are the tests?**  
A: All tests are in the `tests/` directory. Run `npm test` for the full suite, or `npm run build:tests && node dist/tests/<file>.js` for individual test files.

---

## Contributing

### Branch Workflow
```
test → dev → main
```

See [WORKFLOW.md](WORKFLOW.md) for detailed branching strategy.

### Before Submitting PR
1. Run tests: `npm test`
2. Verify fund invariants
3. Check index consistency
4. Update documentation
5. Add inline comments for complex logic

---

## Next Steps

1. **Read the Architecture**: [architecture.md](architecture.md)
2. **Understand Fund Logic**: [FUND_MOVEMENT_AND_ACCOUNTING.md](FUND_MOVEMENT_AND_ACCOUNTING.md)
3. **Follow Code Roadmap**: Start with `constants.ts` → `manager.ts`
4. **Try Debugging**: Enable debug logging and explore fund status
5. **Run Tests**: `npm test` to see how components work

Happy coding! 🚀

---

## Environment Variables

Control bot behavior via environment variables (useful for advanced setups):

| Variable | Description |
|----------|-------------|
| `BOT_NAME` / `LIVE_BOT_NAME` | Select a specific bot from `profiles/bots.json` by name |
| `PREFERRED_ACCOUNT` | Override the preferred account for the selected bot |
| `OPEN_ORDERS_SYNC_LOOP_MS` | Open-orders sync polling interval in ms (default: `300000` / 5 minutes) |
| `CALC_CYCLES` | Calculation passes for standalone grid calculator (default: `3`) |
| `CALC_DELAY_MS` | Delay between calculator cycles in ms (default: `500`) |
| `DEXBOT_PROFILE_ROOT` | Override the profiles directory (default: `~/.config/dexbot2/profiles` for all installs; a source checkout keeps `<install-root>/profiles` while a populated profiles dir exists there — `bots.json`, `keys.json`, settings, or launcher config) |
| `DEXBOT2_ROOT` | Base directory whose `profiles/` subdirectory is used (legacy; overridden by `DEXBOT_PROFILE_ROOT`) |
| `DEXBOT_MARKET_ADAPTER_DATA_DIR` | Override the market adapter candle/data directory (default: `<install-root>/market_adapter/data` when profiles resolve to the install root, else `<profiles>/market_adapter/data`) |
| `DEXBOT_MARKET_ADAPTER_STATE_DIR` | Override the market adapter state directory (default: `<install-root>/market_adapter/state` when profiles resolve to the install root, else `<profiles>/market_adapter/state`) |
| `DEXBOT_CLAW_DATA_DIR` | Override the claw data directory — positions, watcher health, memu (default: `<install-root>/claw/data` when profiles resolve to the install root, else `<profiles>/claw/data`) |

User state (profiles, market-adapter data/state, and claw data) defaults to
`~/.config/dexbot2/profiles` for all installs, so it lives outside the
repo/package tree, survives re-clones and `npm update -g`, and is never wiped
by package reinstalls. A source checkout with an existing populated `profiles/`
dir (any well-known profile file: `bots.json`, `keys.json`, settings, or launcher
config — not just bots) keeps its current `<install-root>/profiles` layout until
a home config exists (or a `DEXBOT_PROFILE_ROOT` override is set). The
`dexbot clear*` / `dexbot default` CLI commands and the shipped
`scripts/clear-*.sh` resolve the same directories via
`scripts/lib/dexbot-paths.sh`. If market-adapter/claw state is relocated away
from a repo that still holds old files, a startup notice points at the new
location and the env overrides to migrate.

Example — run a specific bot with a custom sync interval:
```bash
BOT_NAME=my-bot OPEN_ORDERS_SYNC_LOOP_MS=30000 dexbot start
```

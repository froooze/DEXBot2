# DEXBot2 Fund Movement & Accounting Technical Reference

## 1. Core Accounting Model

The accounting system is designed around a **Single Source of Truth** principle with **Optimistic Execution**. It prevents double-spending while maximizing capital efficiency by treating pending proceeds as immediately available ("Optimistic ChainFree").

### 1.1 Fund Components

> **Naming convention:** Capitalized prose names below (e.g. `ChainFree`, `Virtual`, `Committed`) refer to the abstract fund component. The corresponding code identifier is shown in the **Code Reference** column — most are scoped per side, e.g. `ChainFree` resolves to `accountTotals.buyFree` on the buy side and `accountTotals.sellFree` on the sell side.

| Component | Code Reference | Definition & Ownership |
|-----------|----------------|------------------------|
| **ChainFree** | `accountTotals.buyFree` | **Liquid Capital**. The unallocated balance on the blockchain. <br> *Balanced:* Deducted pre-emptively on fills to offset state release. |
| **Virtual** | `funds.virtual` | **Planned Capital**. Sum of sizes for orders in `VIRTUAL` state. <br> *Purpose:* Prevents `ChainFree` from being re-spent on overlapping grid layers. |
| **Committed (Chain)** | `funds.committed.chain` | **Locked Capital**. Sum of sizes for `ACTIVE` + `PARTIAL` orders (including those without `orderId` yet). <br> *Source:* Real-time grid state + on-chain orders. |
| **Committed (Grid)** | `funds.committed.grid` | **Strategy Capital**. Alias for `committed.chain` in the current engine. |
| **Allocated** | `funds.allocated.{buy,sell}` | **Capital Budget**. The bot's configured share of total capital per side. <br> *Source:* `applyBotFundsAllocation()` applies `botFunds` config (percentage or absolute) against `chainTotal` (free + committed). <br> *Purpose:* All order sizing (`getSideBudget`, `_getSizingContext`) reads from `Allocated`, not raw `ChainFree`, ensuring the bot never exceeds its configured capital share. |
| **FeesOwed** | `funds.btsFeesOwed` | **Liability**. Accumulated blockchain fees (BTS) that must be settled. |
| **FeesReservation** | `btsFeesReservation` | **Safety Buffer**. Reserved BTS to ensure future grid operations (creation/cancellation) don't fail. |

### 1.2 The Available Funds Formula

This formula determines the bot's spending power. It is calculated atomically in `math.ts::calculateAvailableFundsValue`.

$$Available = \max(0, \text{ChainFree} - \text{Virtual} - \text{FeesOwed} - \text{FeesReservation})$$

**Critical Invariants:**
1.  **Virtual represents Plan.** Orders remain in `Virtual` only while they are truly uncommitted. As soon as they move to `ACTIVE`, they move to `Committed` (Chain), even if the blockchain transaction is still in flight. This maintains the `Total = Free + Committed` invariant.
2.  **Available Funds = True Spending Power.** This formula is the single source of truth for how much capital can be deployed immediately.
3.  **Non-BTS pair reservation.** When neither asset is BTS, the formula adds an extra proportional deduction: any BTS fee-budget deficit (formula budget minus `funds.btsBalance.free`) is split across `buyFree` + `sellFree` proportional to each side's free balance, and the side's share is subtracted from `Available`. See `calculateAvailableFundsValue()` in `modules/order/utils/math.ts` (lines 407–425).

### 1.3 Capital Allocation Pipeline

The raw `Available` from §1.2 is the bot's immediate spending power, but **order sizing does not use it directly**. A separate allocation pipeline applies the `botFunds` cap to produce `funds.allocated`, which is the budget source for all grid operations.

**Pipeline:**

```
accountTotals.buyFree / sellFree           (raw chain free)
        + funds.committed.chain             (+ what's locked in orders)
        → computeChainFundTotals()
          → chainTotalBuy / chainTotalSell  (total capital per side)

chainTotal × botFunds%                      (apply botFunds cap)
        → resolveConfigValueWithRegistry()
          → funds.allocated.{buy,sell}      (bot's capital budget)

funds.allocated → getSideBudget()           (budget for target grid sizing)
funds.allocated → _getSizingContext()       (budget for spread correction)
```

**Key points:**
- `botFunds` percentage applies to **total** capital (free + locked in orders), not just free. A bot at `"50%"` gets half of everything, not half of what's currently idle.
- `funds.allocated` is the ceiling for each side. Existing orders already consume part of it; the remaining free portion is available for new placements.
- The downstream `applyBotFundsAllocation()` (`manager.ts:654`) also caps `funds.available` to `<= allocated` as a safety net, but the primary budget chokepoint is `getSideBudget` / `_getSizingContext` reading `allocated` directly (v1.2.6).

---

### 1.4 Mixed Order Fund Validation

**Problem Fixed**: Early batch builders ran a single fund check keyed off the first order's side, so a mixed BUY/SELL batch could trip a false "insufficient funds" warning even when each side had ample capital — the BUY check was applied to SELL orders (or vice versa).

**Solution**: Per-asset validation using a signed-delta water-mark. The current validator tracks the **peak** running requirement per asset (not a side lump sum), so BUY and SELL ops in the same batch are validated independently against their own free balance.

#### Fund Availability Checks by Asset

- **BUY orders** sell quote asset (assetB), so they are validated against `accountTotals.buyFree` — the unallocated assetB available for limit orders.
- **SELL orders** sell base asset (assetA), so they are validated against `accountTotals.sellFree` — the unallocated assetA available for limit orders.

#### Implementation Location

File: `modules/dexbot_class.ts` — `_validateOperationFunds()` (line 3093), called from the COW batch broadcast path at line 4163.

```javascript
// Per-asset peak requirement vs. quantized chain-free snapshot.
// Updates consume a signed delta (size delta); creates consume the full amount.
for (const op of operations) {
    // ... resolve sellAssetId / sellAmountInt from op_data ...
    netRequiredFunds[sellAssetId] += signedDelta;          // net after releases
    runningRequiredFunds[sellAssetId] += signedDelta;      // running watermark
    peakRequiredFunds[sellAssetId] = max(peak, running);   // high-water mark
}

const availableFunds = {
    [assetA.id]: quantizeFloat(snap.chainFreeSell, assetA.precision),
    [assetB.id]: quantizeFloat(snap.chainFreeBuy,  assetB.precision)
};

// Precision-aware comparison: int-cast both sides before comparing.
if (floatToBlockchainInt(peak, prec) > floatToBlockchainInt(available, prec)) {
    fundViolations.push({ asset, required: peak, netRequired, available, deficit });
}
```

#### Key Points

1. **Each asset validated independently** against its own free balance (`buyFree` for assetB, `sellFree` for assetA).
2. **Peak-tracking** catches interleaved create+update ops whose net is affordable but whose intermediate watermark is not.
3. **No double-counting** when BUY and SELL orders are placed in the same batch — they draw from disjoint asset pools.
4. **Quantized comparison** (`floatToBlockchainInt`) eliminates float-accumulation false positives.

#### Helper Reference

For checking order types and states, use centralized helpers from `modules/order/utils/order.ts`:
- `isOrderOnChain(order)` - Check if ACTIVE or PARTIAL
- `isOrderPlaced(order)` - Check if safely placed (on-chain with ID)
- `isOrderVirtual(order)` - Check if VIRTUAL state

See [developer_guide.md#order-state-helper-functions](developer_guide.md#order-state-helper-functions) for complete helper function reference.

---

### 1.5 Fill Batch Processing & Timeline

#### Problem Solved

Previously, fills were processed one-at-a-time (~3s per broadcast). A burst of 29 fills in the Feb 7 market crash took ~90 seconds, during which:
- Market prices moved significantly
- Orders became stale (filled on-chain but not yet synced)
- Orphan fills were created (fill events for orders no longer on-chain)
- Fund tracking diverged from blockchain reality

**Impact**: The extended 90s window meant the bot couldn't react to market moves, creating a cascading failure.

#### Solution: Fixed-Cap Batch Fill Processing

**Mechanism**: Fill events arrive via `modules/dexbot_fill_runtime.ts` (the fill-runtime module), which pushes them into `bot._incomingFillQueue` (declared in `modules/dexbot_class.ts`). The drain loop in `dexbot_class.ts` then chunks the queue into capped batches and calls `modules/order/manager.ts::processFilledOrders` (line 1149) once per chunk to run the full rebalance pipeline.

**Batch Sizing Algorithm**: A single cap-based batch size (`FILL_PROCESSING.MAX_FILL_BATCH_SIZE`): a queue depth of 4 or fewer is processed as one unified batch; deeper queues are chunked into repeated batches of 4 (the last chunk may be smaller).

**Configuration** (`modules/constants.ts`):
```javascript
FILL_PROCESSING: {
  MAX_FILL_BATCH_SIZE: 4            // Hard cap on batch size
}
```

#### Fill Batch Processing Timeline

**Per-Batch Execution**:

1. **Peek & Pop**: Check `_incomingFillQueue`, pop up to N fills (batch size)
2. **Single Accounting Pass**: Call `processFillAccounting()` once for all N fills
   - All proceeds credited directly to `chainFree` (via `adjustTotalBalance`)
   - All proceeds immediately available to next rebalance cycle (not split across cycles)
3. **Single Target Calculation**: Call `calculateTargetGrid()` once
   - Sizes replacement orders using combined proceeds
   - Applies rotations and boundary shifts
4. **Batch Broadcast**: Call `updateOrdersOnChainBatch()` once
   - All new orders + cancellations in single operation
5. **Persist**: Call `persistGrid()` to save grid state
6. **Loop**: Continue with next batch (or idle if queue empty)

**Result**: 29 fills now processed in ~8 broadcasts (~24s) instead of 29 broadcasts (~90s).

#### Grid Regeneration Trigger (Available Funds Ratio)

The grid regenerates when accumulated proceeds create a significant funding imbalance. This is detected using the **Available Funds Ratio**:

```
ratio = (availableFunds / allocatedCapital) * 100

IF ratio >= GRID_REGENERATION_PERCENTAGE (default: 3%):
    → Trigger grid regeneration
```

**How It Works**:
1. Fill occurs → proceeds added to `chainFree`
2. `calculateAvailableFundsValue()` computes true spending power (chainFree minus reservations)
3. Grid divergence check compares this ratio against allocated capital in active orders
4. If ratio exceeds 3%, the grid has accumulated enough proceeds to warrant redeployment
5. Grid regeneration recalculates all order sizes and applies new placements

#### Recovery Retry System

**Problem**: One-shot `_recoveryAttempted` boolean flag meant permanent lockup if recovery failed once.

**New Behavior**: Count+time-based retry system with periodic reset.

**State Machine**:
```
INITIAL (count=0, time=0)
    ↓
RECOVERY_FAILED (count++, time=now) ← Recovery attempted but failed
    ↓ (wait 60s)
READY_RETRY (count < 5 and time_elapsed ≥ 60s) ← Time passed, can retry
    ↓
RECOVERY_ATTEMPTED (increment count) ← Attempt retry
    ↓ (on fail) ← Success not yet
    ↓ ← Loops back to RECOVERY_FAILED
    ↓ (on success)
RESET via resetRecoveryState() ← Recovery succeeded, reset for next episode
```

**Configuration** (`modules/constants.ts`):
```javascript
PIPELINE_TIMING: {
  RECOVERY_RETRY_INTERVAL_MS: 60000,  // Min 60s between retry attempts
  MAX_RECOVERY_ATTEMPTS: 5            // Max 5 retries per episode (0 = unlimited)
}
```

**Reset Points** (Called by `resetRecoveryState()` in `modules/order/accounting.ts`):
1. **Fill-triggered**: Every fill in `processFilledOrders()` resets recovery state
2. **Periodic**: Blockchain fetch loop resets state every 10 minutes (even if no fills)
3. **Bootstrap completion**: After grid initialization

**Impact**: 
- ✅ If recovery fails, bot retries every 60s instead of requiring manual restart
- ✅ Self-heals within minutes after market settles
- ✅ No permanent lockup from single failure

#### Stale-Cleaned Order ID Tracking (see §3.6)

When a batch fails because an on-chain order no longer exists, the cleanup releases the local slot — but a delayed orphan-fill event can still arrive and re-credit the proceeds, double-counting capital. The bot tracks stale-cleaned order IDs in `_staleCleanedOrderIds` and skips crediting any fill whose order is still in that map. The full mechanism, data structure, and TTL rules are documented in [§3.6 Orphan-Fill Deduplication & Double-Credit Prevention](#36-orphan-fill-deduplication--double-credit-prevention).

---

### 1.6 Remainder Accuracy During Capped Resize

#### Problem Fixed

When grid resize was capped by available funds, the accounting system needed to track what portion of the ideal grid went unallocated. This required careful per-slot tracking to distinguish between:
- **Fully allocated slots**: received their ideal size (no remainder)
- **Fund-capped slots**: received less than ideal because available funds ran out mid-allocation

Without per-slot tracking, the remainder was computed from totals, which overstated it when some slots were fully allocated and others were capped.

#### Solution: Per-Slot Tracking

**Old Behavior** (Incorrect):
```javascript
// Compute unallocated remainder from ideal sizes
const remainder = totalIdealSizes - totalAllocatedSizes;
// Problem: If actual allocation capped at 80% due to insufficient funds,
// this uses 100% ideal in calculation → remainder overstated
```

**New Behavior** (Correct):
```javascript
// Track per-slot applied sizes
const appliedSizes = [];
for (const slot of slots) {
    const appliedSize = min(idealSize[slot], availableFundsRemaining);
    appliedSizes.push(appliedSize);
    availableFundsRemaining -= appliedSize;
}

// Compute unallocated remainder from actual allocated values
const remainder = totalIdealSizes - sum(appliedSizes);
// Result: Reflects true remaining capacity for next cycle
```

**Impact**:
- ✅ Remainder accurately reflects what was NOT allocated due to fund caps
- ✅ Next rebalance cycle gets correct available fund picture
- ✅ No skewed sizing decisions

---



## 2. Grid Topology & Sizing

The grid is a unified array ("Master Rail") of price levels, not separate Buy/Sell arrays.

### 2.1 Geometric Weighting Formula

Order sizes are calculated using a geometric progression to distribute risk.

**Inputs:**
-   $N$: Number of orders
-   $Total$: Total budget for side
-   $w$: Weight Distribution parameter (`-1` to `2`)
-   $inc$: Increment factor (`incrementPercent / 100`)

**Base Factor:**
$$base = 1 - inc$$

**Raw Weight ($W_i$):**
For each slot $i$ from $0$ to $N-1$:
$$W_i = base^{(i \times w)}$$

**Orientation:**
-   **SELL Side:** Normal indexing ($i=0$ is market-closest).
-   **BUY Side:** Reversed indexing ($i=N-1$ is market-closest) to ensure heaviest weights are always near the spread.

**Final Size ($S_i$):**
$$S_i = \left( \frac{W_i}{\sum W} \right) \times Total$$

### 2.2 Spread Gap & Boundary

The grid is divided into zones by a dynamic **Boundary Index**.

-   **Gap Size ($G$):** Calculated from `targetSpreadPercent` and `incrementPercent`.
    $$G = \lceil \frac{\ln(1 + \text{targetSpread}/100)}{\ln(1 + \text{increment}/100)} \rceil - 1$$
    *(Min capped at `MIN_SPREAD_ORDERS`, usually 2. The $-1$ accounts for the naturally occurring center gap during grid centering)*

-   **Zones:**
    -   **BUY:** Indices $[0, \text{boundaryIdx}]$
    -   **SPREAD:** Indices $[\text{boundaryIdx}+1, \text{boundaryIdx}+G]$ (Total of $G+1$ actual gaps)
    -   **SELL:** Indices $[\text{boundaryIdx}+G+1, N]$

---

## 3. The Strategy Engine (Boundary-Crawl Algorithm)

The rebalancing logic (`strategy.ts::calculateTargetGrid`) computes the target "Crawl" state.

### 3.1 Boundary Shift (The Crawl)
When a fill occurs, the boundary shifts to "follow" the price.
-   **BUY Fill:** Market moved down $\to$ `boundaryIdx--` (Shift Left).
-   **SELL Fill:** Market moved up $\to$ `boundaryIdx++` (Shift Right).

### 3.2 Global Side Capping

Budgets are dynamic. The bot calculates `TotalSideBudget` from `funds.allocated.{buy,sell}` (the `botFunds`-capped capital per side — see §1.3). This ensures the bot never attempts to deploy more than its configured share of account capital, even when the account holds additional free balance for other bots or manual trading.

**Safety Check:**
If the calculated ideal grid requires more capital than available in the allocation, the *increase* is capped.
$$Increase_{capped} = \min(Ideal - Current, AllocatedRemaining)$$

#### Batch Sizing Impact

During fill batch rebalancing, the unallocated remainder (amount NOT allocated due to fund caps) affects available funds for the next cycle:

**Remainder Calculation**:
- **Old**: Computed from ideal sizes even when resize was capped
- **New**: Tracked per-slot, derived from actual allocated values

**Effect on Side Capping Formula**:
```javascript
// In next rebalance cycle:
availableFunds = chainFree - virtual - feesOwed - feesReservation
sideIncrease = min(idealSide - currentSide, availableFunds)

// When batch capping applied in previous cycle:
// availableFunds now correctly reflects the unfulfilled allocation gap
```

**Example**:
```
Cycle N (Batch Processing):
- Ideal grid total: 1000 BTS
- Available funds: 600 BTS
- Allocate: 600 BTS (per-slot tracking)
- Unallocated remainder: 400 BTS (1000 - 600)

Cycle N+1:
- Unallocated remainder (400 BTS) available for next allocation
- Prevents "stuck fund" situations where capital appeared allocated but wasn't
```

**Impact**:
- ✅ Accurate available fund calculations for next rebalance
- ✅ No overstated fund capping in subsequent cycles
- ✅ Smooth rebalancing when market moves expand/contract positions

### 3.3 The Rotation Cycle
Rotations move capital from "Surplus" (useless) to "Shortage" (needed).

1.  **Identify Shortages:** Empty slots *inside* the active window (near boundary).
2.  **Identify Surpluses:** Active orders *outside* the window (far edges).
3.  **Sort:**
    -   Shortages: Closest to market first.
    -   Surpluses: Furthest from market first.
4.  **Execute:**
    For each pair (Surplus $S$, Shortage $T$):
    -   **Atomic Transition:**
        -   $S$ state: `ACTIVE` $\to$ `VIRTUAL` (size 0, releases funds).
        -   $T$ state: `VIRTUAL` (size $S_{size}$, reserves funds).
    -   **Fund Calculation:**
        -   The released funds from $S$ are immediately added to `ChainFree`.
        -   The reserved funds for $T$ are immediately subtracted (added to `Virtual`).

### 3.4 Edge-First Surplus Sorting

**Change**: Prioritize furthest-from-market surpluses (lowest Buy / highest Sell) for rotations.

**Reason**: Improves execution robustness by using stable edge orders for rotations and leaving volatile inner surpluses to potentially catch "surplus fills" during grid shifts.

**Impact**:
- ✅ More stable rotation candidates (outer orders less likely to be filled mid-operation)
- ✅ Inner surpluses remain available for spontaneous fill opportunities
- ✅ Reduces unnecessary churn on volatile price action

### 3.5 Victim Cancel Safety Logic

**Change**: Explicitly detect and cancel "victim" dust orders when a rotation targets an occupied slot.

**Reason**: Maintains 1-to-1 mapping between grid slots and blockchain orders in the Edge-First system, preventing "ghost" capital on-chain.

**Implementation**:
```javascript
// If rotation target slot has an order (victim), cancel it first
if (targetSlot.orderId) {
    scheduleCancel(targetSlot);
    targetSlot.state = VIRTUAL;  // Prepare slot for new order
}

// Then place new order at target
targetSlot.state = ACTIVE;
targetSlot.orderId = newOrderId;
```

**Impact**:
- ✅ Prevents "ghost" capital lingering on-chain
- ✅ Ensures grid slot ↔ blockchain order 1-to-1 mapping
- ✅ No orphaned capital in rotation operations

---

### 3.6 Orphan-Fill Deduplication & Double-Credit Prevention

**Location**: `modules/dexbot_class.ts` — constructor, `_recoverExplicitStaleOrders()` (line 530), orphan-fill guard in the fill drain loop (line ~1633), and pruning pass after each cycle (line ~1919).

#### Problem Solved

During Feb 7 market crash, stale-order batch failures cascaded into double-crediting:

**Scenario**:
1. Batch operation scheduled with 12 orders
2. Order X is on-chain, included in batch
3. Between sync and broadcast, order X fills on market (stale order)
4. Batch execution fails: "Limit order X does not exist"
5. Error handler: Clean up grid slot X, release funds to `chainFree`
6. Meanwhile, fill event arrives: "Order X was filled at price Y for amount Z"
7. Orphan-fill handler: Credits proceeds to `chainFree` AGAIN
8. **Result**: Double-credit of proceeds, inflated `chainTotal`, fund drift

**In Crash Numbers**: 7 orphan fills × ~700 BTS = ~4,600 BTS inflated → cascaded to 47,842 BTS total drift.

#### Solution: Stale-Cleaned Order ID Tracking with TTL + Recycled-Slot Guard

**Mechanism**: Track which orders were cleaned up during batch failure recovery using timestamp + grid-slot retention.

**Data Structure** (`modules/dexbot_class.ts`):
```javascript
// Map of orderId → { markedAt: number, gridId: string | null }
_staleCleanedOrderIds = new Map();

// Retention window (set in the constructor):
_staleCleanupRetentionMs = Math.max(_fillDedupeWindowMs, 5 * 60 * 1000);  // ≥5 minutes
```

**Cleanup Process** (in `_recoverExplicitStaleOrders()`):
```javascript
1. Parse error message for stale order IDs (e.g., "Limit order 12345 does not exist")
2. For each stale ID matching a grid slot:
   - Virtualize the grid slot (state → VIRTUAL, size 0)
   - Record: _staleCleanedOrderIds.set(orderId, { markedAt: Date.now(), gridId })
3. For stale IDs with no matching grid slot:
   - Record: _staleCleanedOrderIds.set(orderId, { markedAt: Date.now(), gridId: null })
```

**Orphan-Fill Handler Check** (in the drain loop):
```javascript
const entry = _staleCleanedOrderIds.get(orderId);
if (entry) {
    const ageMs = Date.now() - entry.markedAt;
    if (ageMs <= _staleCleanupRetentionMs) {
        // Within retention: skip credit entirely (funds already freed)
        continue;
    }
    if (entry.gridId) {
        const currentOrder = manager.orders.get(entry.gridId);
        if (currentOrder?.orderId && currentOrder.orderId !== orderId) {
            // Slot recycled: funds already redeployed — skip credit
            continue;
        }
    }
    // Expired and slot not recycled: drop the tombstone and credit as normal orphan
    _staleCleanedOrderIds.delete(orderId);
}
// Credit proceeds only if NOT protected above
await adjustTotalBalance(orderType, proceeds, `orphan-fill-${orderId}`);
```

#### Why This Works

1. **Delayed Orphans**: Fill events can arrive minutes after batch failure (network latency); the retention window covers the dedupe interval.
2. **Recycled-Slot Tombstones**: Entries *with* a `gridId` are kept indefinitely as tombstones — a fill arriving after TTL is still skipped if the slot has been redeployed, preventing a late orphan from double-counting freed-and-redeployed capital.
3. **Bounded Entry Pruning**: Entries *without* a `gridId` (no slot to check) are pruned once `ageMs > _staleCleanupRetentionMs`, so the map stays bounded. Pruning runs after each fill-processing cycle, not on a fixed timer.
4. **ID-Based**: Works with any error format (different BitShares versions have different error messages).
5. **Explicit Logging**: `[ORPHAN-FILL] Skipping double-credit` / `slot recycled` / `Pruned N expired` messages create an audit trail.

#### Fund State Verification

The available funds are verified at allocation time:
- Proceeds are only added to `chainFree` when confirmed on blockchain
- Stale-cleaned orders don't consume allocation funds
- Next cycle sees accurate available funds for sizing decisions

#### Impact

- ✅ **Eliminates double-counting root cause** that fed 47,842 BTS drift
- ✅ **Handles network-latent orphan events** (not just immediate fills)
- ✅ **No fund corruption** from delayed fill events after batch failure
- ✅ **Production stability** after market crashes and stale order cascades

---

## 4. Partial Order Handling (Simplified Consolidation)

When a grid is regenerated or resized, existing partial orders (partially filled orders) may remain on-chain. Rather than employing complex merge/split mechanics, the system uses a **direct consolidation approach** focused on fund efficiency and spreading simplicity.

### 4.1 Dust Detection

A partial order is classified as **Dust** if:
$$Size_{current} < Size_{ideal} \times 0.05$$

Dust orders are too small to be efficient on-chain and are marked for consolidation into the grid rebuild cycle.

### 4.2 Consolidation Strategy

When the strategy engine encounters partial orders during rebalancing:

**Direct Approach** (Simplified):
1. **Identify unhealthy partials**: Detect any partial orders below the 5% dust threshold on each side
2. **Mark for consolidation**: Flag partials as needing attention in the next rebalance cycle
3. **Fund-driven grid rebuild**: Rather than complex slot-by-slot merge/split logic, the entire grid is regenerated based on current total funds (including proceeds from fills)
4. **Natural redistribution**: The rebuilt grid automatically sizes all orders (including those replacing consolidation candidates) using the Ideal Grid sizing formula
5. **Spread maintenance**: The target spread gap remains constant at `targetSpreadPercent`—no dynamically inflated corrections

**Why This Works**:
- **Simpler code path**: No merge vs. split decision logic
- **Fund-safe**: Rebuild uses only available funds; orders that can't be sized are skipped
- **Constant spread**: The spread gap size stays fixed, improving predictability
- **Minimal blockchain interaction**: Grid regeneration happens once per consolidation event (not per partial)

### 4.3 Fund Dynamics During Consolidation

When consolidating partials:

1. **Proceeds become available**: Fill proceeds from the partial are added to `chainFree`
2. **Grid regenerates once**: A single rebalance cycle recalculates all order sizes based on total funds
3. **Partial slot replaced naturally**: The new ideal grid may place a fresh order at the partial's price, or skip it if insufficient funds
4. **No special "doubling" flags**: All slots are treated uniformly—no side-specific bonuses or penalties

**Boundary Behavior**:
- The boundary index shifts with each fill (as before) to follow market movement
- Grid slots are reassigned based on the new boundary and available funds
- No additional spread-widening corrections triggered by partial consolidation

**Fund Consumption**:
Only the net sizing operations consume funds. Since partials are absorbed into the grid rebuild, fund impact is purely from the new order placements in the regenerated grid.

---

## 5. Fee Management

The bot manages two types of fees: **Blockchain Fees** (BTS) and **Market Fees** (Asset deduction).

### 5.1 BTS Fees (Blockchain Operations)
BitShares charges fees for `limit_order_create` and `limit_order_cancel`.

-   **Reservation** (`BTS_RESERVATION_MULTIPLIER` in `constants.ts::FEE_PARAMETERS`):
    $$Reserve = N_{active} \times BTS\_RESERVATION\_MULTIPLIER$$
    *(Default: 5× per order — covers create, rotate (cancel+place), update, and cancel over the order's lifetime)*

-   **Settlement (`deductBtsFees`):**
    1.  Check `Funds.btsFeesOwed`.
    2.  If sufficient `chainFree` available: deduct full amount atomically.
    3.  If insufficient: defer settlement and retry when funds become available.

-   **Adoption fee parity (1.4.8):** COW chain-adoption paths charge fees exactly like the normal open-orders loop. `adoptPlacedBatchFromChain` (refused-commit and poll-confirmed paths) and the startup uncertain-create adoption apply the create/cancel/update fees via `_applySync` — previously create-only charging let optimistic BTS drift when a batch's orders were adopted without fee accounting.

-   **Safe fee lookup:** `processBatchResults` uses `getAssetFeesSafe('BTS')` with zero-fee fallbacks — the throwing variant can no longer hard-fail a whole batch after a successful commit (`modules/dexbot_cow_runtime.ts`).

### 5.2 Market Fees (Trade Cost)
These are deducted from the *proceeds* of a fill.

-   **Maker (Limit Orders):** Typically lower fee (e.g., 0.1%).
    -   **Rebate:** On BitShares, Makers often get a fee rebate on cancellation (vesting).
-   **Taker (Market Orders):** Typically higher fee.
-   **Calculation (`processFilledOrders`):**
    ```javascript
    GrossProceeds = Size * Price
    NetProceeds = GrossProceeds - (GrossProceeds * FeePercent)
    ```

---

### 5.3 BTS Fee Object Structure

For BTS fees, the system returns a structured object (not a simple number) with multiple fields for accounting precision.

**Location**: `modules/order/utils/math.ts::getAssetFees()` (line 303). The fee cache itself is populated by `modules/order/utils/system.ts::initializeFeeCache()` (line 568).

#### BTS Fee Object (Always Object)

```javascript
getAssetFees('BTS', amount, isMaker=true)
// Returns (maker example, amount=45000, orderCreationFee=500, MAKER_REFUND_PERCENT=0.9):
{
    netProceeds: 45450,      // amount + refund = 45000 + 450
    total: 45450,            // aliased to netProceeds for downstream use
    refund: 450,              // orderCreationFee * MAKER_REFUND_PERCENT = 500 * 0.9
    isMaker: true            // Flag: is this a maker fee?
}
```

#### netProceeds Calculation

**For Makers** (isMaker = true, gets `MAKER_REFUND_PERCENT` of `orderCreationFee` back):
```
netProceeds = assetAmount + (orderCreationFee * MAKER_REFUND_PERCENT)
// Example: 45,000 asset + (500 fee * 0.9 refund) = 45,450
```

**For Takers** (isMaker = false, no rebate):
```
netProceeds = assetAmount
// Example: 45,000 asset (no refund) = 45,000
```

#### Non-BTS Fees (Structured Object When Amount Given)

Without an amount, non-BTS assets return a small percent descriptor. With an amount, they return the same `{ netProceeds, total, ... }` shape as BTS (but with `feeAmount` instead of `refund`):

```javascript
getAssetFees('IOB.XRP', 1000)
// Returns (assumes 0.1% maker market fee, maxMarketFee not binding):
// { netProceeds: 999, total: 999, feeAmount: 1, feePercent: 0.1, isMaker: true }

getAssetFees('USD')          // no amount → percent descriptor only
// Returns: { marketFee: <cached>, takerFee: <cached>, percent: <resolved> }
```

#### Backwards Compatibility

Code can safely detect the shape:

```javascript
// With an amount, both BTS and non-BTS return an object carrying netProceeds.
if (typeof feeInfo === 'object' && feeInfo !== null) {
    const proceeds = feeInfo.netProceeds;   // works for BTS and non-BTS
} else {
    // Percent-descriptor path (no amount supplied): use feeInfo.percent
    const feePercent = feeInfo.percent ?? 0;
}

// Legacy fields on the BTS no-amount descriptor (still present):
const createFee = feeInfo.createFee;   // BTS only
```

---

### 5.4 BUY Side Sizing & Fee Accounting

**Problem Fixed**: BUY side fee calculations incorrectly applied fees to base asset instead of quote asset.

**Solution**: Corrected fee accounting with proper asset assignment.

#### Fee Application by Side

| Side | Asset | Calculation | Notes |
|------|-------|-------------|-------|
| **BUY** | Quote (assetB) | Fee deducted from `buyFree` | Buyers pay in quote currency |
| **SELL** | Base (assetA) | Fee deducted from `sellFree` | Sellers pay in base currency |

#### Example Scenario

```
Trading pair: XRP (base) / USD (quote)

BUY Order Fills:
- Receives: 1000 XRP
- Pays: 45,000 USD
- Fee: 500 USD (0.1% of 45,500 total)
- Net proceeds: 45,000 USD (quoted asset reduced by fee)

SELL Order Fills:
- Receives: 45,000 USD
- Pays: 1000 XRP
- Fee: 1 XRP (0.1% of 1000 total)
- Net proceeds: 999 XRP (base asset reduced by fee)
```

#### Maker Refund Impact on BUY Orders

For BUY orders that are makers:

```javascript
// Market fill amount: 45,500 USD worth
// Maker fee: 500 USD (0.1%)
// Maker refund: 90% of 500 = 450 USD back

// Net proceeds to chainFree:
// - Deposit: 45,500 USD (market received)
// - Fee paid: -500 USD
// - Refund received: +450 USD
// - Final: 45,450 USD credited to buyFree
```

**Impact**: Ensures internal ledgers match blockchain totals exactly, preventing accounting drift from fee variances.

---

### 5.5 Precision & Quantization

**Problem**: Floating-point arithmetic accumulates rounding errors over many calculations. After dozens of order size calculations, price derivations, and fund allocations, float values drift from their true blockchain integer representations, causing mismatches between internal state and on-chain reality.

**Solution**: Centralized quantization utilities that eliminate float accumulation by round-tripping through blockchain integer representation.

#### 5.5.1 Core Quantization Functions

**Location**: `modules/order/utils/math.ts` (line 260)

##### `quantizeFloat(value, precision)` - Eliminate Accumulation Errors

Converts float → blockchain int → float to "snap" values to precision boundaries.

```javascript
/**
 * Quantize a float value by round-tripping through blockchain integer representation.
 * Converts float → blockchain int (satoshi-level precision) → float.
 * Eliminates floating-point accumulation errors.
 *
 * @param {number} value - Float value to quantize (e.g., 45.123456789)
 * @param {number} precision - Asset precision (e.g., 8 for satoshis)
 * @returns {number} Quantized float value (e.g., 45.12345679)
 */
function quantizeFloat(value, precision) {
    return blockchainToFloat(floatToBlockchainInt(value, precision), precision);
}

// Example:
// Input: 45.123456789 (accumulated float error)
// Step 1: Float → Int: 45.123456789 * 10^8 = 4512345678.9 → rounds to 4512345679
// Step 2: Int → Float: 4512345679 / 10^8 = 45.12345679 (corrected!)
```

**Use Cases:**
- After fund allocation calculations (prevent 0.000000001 drift)
- When rounding order sizes to blockchain precision
- Before storing prices for comparison operations
- After grid divergence calculations

##### `normalizeInt(value, precision)` - Ensure Integer Alignment

Converts int → float → int to ensure the integer aligns with precision boundaries.

```javascript
/**
 * Normalize an integer value by round-tripping through float representation.
 * Converts int → float (readable format) → blockchain int.
 * Ensures the integer aligns with precision boundaries.
 * Used for precision-aware comparisons.
 *
 * @param {number} value - Integer value (e.g., 4512345679)
 * @param {number} precision - Asset precision
 * @returns {number} Normalized integer value
 */
function normalizeInt(value, precision) {
    return floatToBlockchainInt(blockchainToFloat(value, precision), precision);
}

// Example: Ensure consistency in size comparisons
const currentSizeInt = 4512345679;
const idealSizeInt = 4512345679;
const normalized = normalizeInt(currentSizeInt, 8);
// Returns normalized value for consistent == comparisons
```

**Use Cases:**
- Ensuring order sizes align to blockchain satoshi boundaries
- Normalizing fund totals before invariant checks
- Preparing sizes for blockchain transaction encoding

#### 5.5.2 Consolidation Impact

Previously, five separate quantization implementations existed:
- `dexbot_class.ts` - Manual rounding logic
- `order.ts` - Custom precision handling
- `strategy.ts` - Divergent rounding approach
- `chain_orders.ts` - Different quantization pattern
- `export.ts` - Isolated float conversions

**After Consolidation:**
✅ Single source of truth (`math.ts`)
✅ Consistent precision handling across all modules
✅ Reduced regression risk (tested once, used everywhere)
✅ Eliminated subtle float accumulation bugs
✅ All 34+ test suites pass with zero regressions

#### 5.5.3 Precision Best Practices

| Scenario | Function | Example |
|----------|----------|---------|
| **Calculate order size** | `quantizeFloat()` | `quantizeFloat(45.123456789, 8)` → Snap to satoshi |
| **Compare sizes** | `normalizeInt()` | Ensure both sides use same integer representation |
| **Fund allocation** | `quantizeFloat()` | After geometric distribution, eliminate drift |
| **Price derivation** | `quantizeFloat()` | Pool/market price calculations prone to float errors |
| **Validate blockchain match** | `normalizeInt()` | Check: `normalizeInt(internal) === normalizeInt(chain)` |

#### 5.5.4 Relationship to Fund Validation

The corrected fund validation in `_validateOperationFunds()` uses quantized values:

```javascript
// Check: Does required amount fit in available balance?
const availableBalance = snap.chainFreeSell;  // Quantized by accounting
const requiredAmount = quantizeFloat(totalRequired, precision);  // Quantize for comparison

if (requiredAmount > availableBalance) {
    // Reject batch before broadcasting
    return { valid: false, reason: 'Insufficient funds' };
}
```

This prevents the bug where `available = chainFree + required` created a tautology (`required > chainFree + required` always false). Quantized comparisons now accurately reflect blockchain constraints.

---

## 6. Safety & Invariants

The `Accountant` enforces strict mathematical invariants to detect bugs or manual interference. Invariants are checked by `_verifyFundInvariants()` (`modules/order/accounting.ts` line 471) after every blockchain sync cycle. The verification reads from a snapshot captured under `_fundLock` — `actualBuy`/`actualSell` are captured at snapshot time, not read live outside the lock, closing a TOCTOU window. When a violation is detected, the system logs a `CRITICAL` error and attempts automatic recovery via `manager.accountant.recalculateFunds()` (`modules/order/accounting.ts` line 352, delegated from `modules/order/manager.ts` line 802) — resetting internal state to match on-chain reality. If the grid lock is held (mid-rebalance), recovery is deferred until the lock is released. The bot continues operating throughout; it does **not** halt on invariant violations.

### 6.1 The Equality Invariant
Total funds on chain must equal free plus committed.
$$Total_{chain} = Free_{chain} + Committed_{chain}$$

This is the primary drift detector. A mismatch means the bot's internal ledger has diverged from blockchain reality — typically caused by a missed fill event, a double-credited orphan, or a fee deducted from the wrong side. Recovery resets `accountTotals` from the live blockchain balances.

### 6.2 The Ceiling Invariant
Grid commitment cannot exceed total wealth.
$$Committed_{grid} \leq Total_{chain}$$

A violation here means the grid has allocated more capital than actually exists on-chain. This can happen if an order was cancelled externally (outside the bot) or if a fill was processed but the commitment was never released. Recovery rebuilds committed totals by walking the current grid state.

### 6.3 Race Condition Protection (TOCTOU)
To prevent "Time-of-Check to Time-of-Use" errors:
1.  **Locking:** `AsyncLock` (re-entrant) prevents concurrent updates to the same order. Nested `acquire()` from the same execution context runs the callback directly instead of queueing, eliminating the `fillLockAlreadyHeld` parameter that previously threaded through 25+ call sites.
2.  **Atomic Deduct:** `tryDeductFromChainFree` checks *and* subtracts in a single synchronous step.
3.  **Bootstrapping:** Fills arriving during startup (`isBootstrapping=true`) are queued until the grid is fully reconciled ([GRID_RECONCILE.md](GRID_RECONCILE.md)).

### 6.4 Stale Accounting & Fee Over-Credit Guards (v1.2.1)
Two additional accounting hardening measures added in v1.2.1:

**Stale `accountTotals` no longer HARD-ABORTs COW commit.** Transient staleness (e.g., the periodic balance fetch overlaps with a COW commit) logs a `WARN` and schedules recovery instead of throwing `ACCOUNTING_COMMITMENT_FAILED`. Totals are also refreshed after bootstrap to prevent a spurious full recovery on the first maintenance cycle.

**Fee-deduction failure escalates to `error`.** When `getAssetFees` throws during fill processing (e.g., network blip), `_deductFeesFromProceeds` previously returned raw proceeds without deduction and logged at `warn` level — silently inflating `accountTotals` over time. The log is now `error` with explicit "fund tracking will over-credit" language so operators can detect the drift source in production logs.

**TOCTOU in `processFillAccounting`.** `_buildBtsDeferredRefundAdjustment` reads `btsFeeState` from `mgr.orders`, but the order lock was acquired after accounting ran. Fixed by acquiring the lock first, then running `processFillAccounting` under the lock. This fix was also ported to POST-RESET and BOOTSTRAP tracked-fill accounting paths.

---
*Technical Reference for DEXBot2 v1.4.13 release*

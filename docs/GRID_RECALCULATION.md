# Grid Recalculation Mechanisms

DEXBot2 has several independent ways to update the grid. They do not all do
the same thing:

- A **full grid resync** rebuilds the grid from current chain orders, the
  current bot configuration, and the accepted dynamic-grid snapshot.
- A **dynamic-grid snapshot write** updates
  `profiles/orders/<botKey>.dynamicgrid.json`; it may or may not request a
  full resync.
- A **maintenance correction** updates existing orders or local grid state
  without changing the accepted AMA center.

The market adapter is the owner of AMA-derived market state. It writes the
accepted `dynamicgrid.json` snapshot first, then writes
`profiles/recalculate.<botKey>.trigger` only when the running bot should
rebuild around that snapshot.

---

## Overview: Grid Update Sources

| Source | Decision Owner | When It Fires | Runtime Action | Effect |
|--------|----------------|---------------|----------------|--------|
| **Initial AMA Snapshot** | Market adapter | Bot has no accepted AMA `gridCenterPrice` yet | Write `dynamicgrid.json`, then write a trigger file | Full grid resync around the first accepted AMA center |
| **AMA Center Move** | Market adapter | Current AMA center moves past the configured delta threshold | Write `dynamicgrid.json`, then write a trigger file | Full grid resync around the new accepted AMA center |
| **AMA Slope Range Move** | Market adapter | Range-scaling bot's accepted AMA-slope baseline moves past threshold | Write range-scaling fields to `dynamicgrid.json`, then write a trigger file | Full grid resync with updated asymmetric range/offset data |
| **RMS Structural Divergence** | Bot runtime maintenance | Current grid shape diverges from persisted grid (ACTIVE + VIRTUAL) by RMS threshold | Refresh `gridCenterPrice` from latest `amaCenterPrice`, then run full grid resync | Full grid resync from latest market-adapter snapshot |
| **Available-Funds Resize** | Bot runtime maintenance | Filled-order proceeds exceed `GRID_REGENERATION_PERCENTAGE` (grow), or grid-tracked size exceeds allocation by that threshold after fund removal (shrink) | Recalculate affected side/order sizes through maintenance logic | Order-size/grid maintenance update, not an AMA recenter trigger |

Each source is evaluated independently. Market-adapter full-resync requests are
serialized through `profiles/recalculate.<botKey>.trigger`. Runtime maintenance
paths execute under the order manager fill-processing lock and may defer until
the bot is idle (no fills, no sync in-flight).

---

## 1. AMA Center Baseline and Trigger File

The market adapter persists the AMA-derived grid center directly. There is no
additional deviation-based price adjustment layer on top of the AMA output.

The adapter writes the current center to `profiles/orders/<botKey>.dynamicgrid.json`
and the grid engine uses that snapshot as the baseline for future delta comparisons.

When a rebuild is required, the adapter writes
`profiles/recalculate.<botKey>.trigger` with JSON metadata such as `reason`,
`newCenterPrice`, `previousCenterPrice`, `amaCenterPrice`, and slope diagnostics.
DEXBot watches the `profiles/` directory and also checks for a pending trigger
before startup grid initialization.

The bot executes the reset through `_performGridResync()`:

1. Acquire `_fillProcessingLock`.
2. Defer if the bot is not idle (fills or sync in-flight).
3. Reload this bot's entry from `profiles/bots.json`.
4. For full-recenter reset reasons, refresh `gridCenterPrice` in
   `<botKey>.dynamicgrid.json` from the latest `amaCenterPrice` before rebuilding.
5. Call `Grid.recalculateGrid()` using fresh open orders from chain (this is runtime resync, not startup reconcile — see [GRID_RECONCILE.md](GRID_RECONCILE.md)). A truncated read (including an ambiguous empty-read confirm) returns `null` here and aborts BEFORE any sync/rebuild. A clean-slate operator trigger passes `clearLastFillGuards`, so the rebuild leaves the guard cold and keeps the boundary structural instead of re-arming/anchoring to the old last fill. Clean-slate triggers come from `dexbot reset`, the claw launcher reset, and default claw settings-patch triggers; a settings patch whose caller supplies an explicit `triggerPayload` `source` other than `manual_grid_full_reset`, or `triggerPayload: null`, stays a normal reset.
6. The live pivot is cold from step 5, so `recalculateGrid`'s own pre-rebuild flush already drops the genesis-bound pivot row; the market-fill row survives until commit, and rollback relies on the in-memory snapshot rather than the disk row. After the rebuild succeeds, erase both persisted guard rows in one locked write and clear the spread watchdog memory; reset fee-debt bookkeeping, persist the rebuilt grid, record actual reset metadata in `dynamicgrid.json`, and remove the trigger file. On a failed/ambiguous rebuild the guard state and watchdog are rolled back and the trigger is retained for retry (an old pivot row is not restored if the failed rebuild already published a new genesis).

Market-adapter triggers carry an explicit `reason` and a `source` derived from
the adapter filename: `"market_adapter/market_adapter.js"` in dist mode, or
`"market_adapter/market_adapter.ts"` in source mode. Only the dist-mode `.js`
source is recognized by the runtime, which then records reset provenance such as
`market_adapter_bootstrap`, `market_adapter_delta_threshold`, or
`market_adapter_ama_slope_delta_threshold` and keeps the last-fill guard. A
source-mode `.ts` trigger currently falls through to manual/legacy handling.
`dexbot reset`, the claw launcher reset, and default claw settings-patch
triggers write `source: "manual_grid_full_reset"` (the shared
`MANUAL_GRID_FULL_RESET_SOURCE` wire value); that is the only payload source
that requests the guard clear. Empty, malformed, and other foreign-sourced
trigger files remain manual/legacy resets, as do settings-patch triggers whose
caller supplies an explicit non-clean-slate `source` or `triggerPayload: null`.

---

## 2. Initial AMA Snapshot Reset

### What It Does
When the adapter has no accepted `gridCenterPrice` baseline for a bot, it persists
the first valid AMA center and writes a reset trigger so the running bot
rebuilds around that center.

**Why it matters:** The adapter and bot must agree on the first grid center. A
first-snapshot trigger prevents the adapter from silently accepting a center while
the bot continues operating on stale or missing dynamic-grid data.

### How It Works

1. `processBot()` detects that the bot has no valid previous `gridCenterPrice`.
2. It writes `profiles/orders/<botKey>.dynamicgrid.json` with `gridCenterPrice`,
   `amaCenterPrice`, AMA slope fields, and whitelisted dynamic weights.
3. Only after that write succeeds, it writes `profiles/recalculate.<botKey>.trigger`
   with `reason: "market_adapter_bootstrap"`.
4. The bot consumes the trigger through the normal grid-resync path.
5. If the snapshot write fails, no trigger is written and the next adapter cycle
   retries the initial snapshot from scratch.

### Debugging

The adapter reports a `triggerSuppressedReason` whenever it decided **not** to
write a trigger this cycle. Each value names a different gate:

| `triggerSuppressedReason` | Meaning |
|---------------------------|---------|
| `ama_center_persist_failed` | Writing `dynamicgrid.json` failed (disk space, permissions, or `writeBotDynamicGrid` dependency) |
| `ama_warmup_insufficient` | Not enough closed candles yet to produce a valid AMA value |
| `waiting_for_new_closed_candle` | AMA history was repaired, but no new candle close has arrived since the last processed one |
| `unresolved_candle_gaps` | Source candle history contains gaps the adapter could not auto-fill |
| `stale_candle_data` | Latest candle close is older than the configured staleness window |
| `fixed_start_price` | Bot uses a fixed start price; AMA-driven recentering is intentionally disabled |
| `ama_slope_persist_failed` | Range-scaling snapshot write failed before the slope trigger could be issued |
| `dynamic_weight_persist_failed` | Dynamic-weight-only snapshot write failed |

When `ama_center_persist_failed` (or `ama_slope_persist_failed` /
`dynamic_weight_persist_failed`) appears repeatedly, check disk space, write
permissions for `profiles/orders/`, and the `writeBotDynamicGrid` service
dependency. The warmup/candle-gap/stale-data reasons clear on their own once
fresh candle data is available; `fixed_start_price` is intentional and only
changes if the bot's start-price mode is reconfigured.

---

## 3. AMA Delta Threshold (Market Adapter)

### What It Does
Monitors the Adaptive Moving Average (AMA) of market prices. When the AMA
center price deviates from the last accepted center by more than the threshold,
the adapter writes a new snapshot and requests a full grid resync.

**Why it matters:** Big market moves require repositioning the grid to stay centered around the new market price.

### Configuration

**File:** `profiles/general.settings.json`
```json
{
  "MARKET_ADAPTER": {
    "AMA_DELTA_THRESHOLD_PERCENT": 1
  }
}
```

For a narrower override, set `deltaThresholdPercent` in
`profiles/market_adapter_settings.json` under either:

- `pairs[].marketAdapterSettings` for one market pair
- `pairs[].botOverrides[<botName>]` for one bot in that pair

**Parameters:**
- `AMA_DELTA_THRESHOLD_PERCENT`: Percentage change in AMA center that triggers grid reset
  - Default: `1%` (in `modules/constants.ts`)
  - Range: `0.1` to `50.0` (configurable via CLI and `dexbot bot` general settings)
  - Example: If set to `1`, the bot fully resyncs when AMA center moves ±1% from the last accepted center

### CLI Override
```bash
node dist/market_adapter/market_adapter.js --deltaPercent 2
```

### Bot Configuration (Complementary)

**File:** `profiles/bots.json` (per bot)
```json
{
  "ama": {
    "erPeriod": 781,     // Efficiency Ratio lookback period (candles)
    "fastPeriod": 5.2,   // Fast smoothing period for trending markets
    "slowPeriod": 83.5   // Slow smoothing period for choppy markets
  }
}
```

> Optional. A bot-level `ama` block overrides the preset (or matched pair profile)
> field by field, and supplying any period marks the bot's AMA as `custom` in the
> adapter state. The values above are the built-in `AMA3` defaults
> (`MARKET_ADAPTER.AMAS`): `erPeriod: 781` and `fastPeriod: 5.2` are shared, while
> `slowPeriod` runs `62.1` (AMA1) to `99.3` (AMA4).

> **`gridPrice` is the only switch.** A bot is AMA-driven when `gridPrice` says
> so — `usesAmaGridPrice()`, the source of truth shared by the bot, maintenance
> and launcher runtimes. There is deliberately no `ama.enabled`: a second switch
> could only disagree with them, freezing the center the bot still trades on. To
> park a bot, set a non-AMA `gridPrice` (`"fixed"`, a number, `"pool"`, `"book"`).

**Optional: `poolRef`** — pin a specific pool ID for price derivation when using `startPrice: "pool"`. Set in `bots.json` alongside the bot entry:
```json
{
  "name": "BTS-USDC",
  "startPrice": "pool",
  "poolRef": "1.19.48"
}
```
The pool is fetched directly by ID, bypassing pool discovery. Useful when the trading pair has no native AMM pool. Accepts short form (`"48"`) or full form (`"1.19.48"`).

**How this interacts with market profiles:**
- `profiles/market_profiles.json` wins first for matched markets
- `gridPrice: "ama"` uses the pair's `defaultAma`
- `gridPrice: "ama1"` through `gridPrice: "ama4"` force that exact preset
- If no pair profile matches, the bot's `ama` block is used as the fallback

**AMA Parameters:**
- `erPeriod`: How many candles to look back for trend detection
  - Higher values: More stable, slower response (e.g. `erPeriod=781` very stable)
  - Lower values: More responsive, catches quick moves
  - Built-in presets use `erPeriod=781` (fitted); per-pair `profiles/market_profiles.json` presets may override it
- `fastPeriod`: Smoothing constant for trending markets
  - Lower = faster response
  - Built-in presets use `fastPeriod=5.2` (fitted)
- `slowPeriod`: Smoothing constant for choppy/sideways markets
  - Higher = more lag, filters noise
  - Built-in presets range from `AMA1` (fastest) to `AMA4` (slowest) — see `MARKET_ADAPTER.AMAS` in `modules/constants.ts` for the exact `slowPeriod` values

AMA parameters resolve in this order: a matched pair profile in
`profiles/market_profiles.json` wins for that pair; otherwise the bot's own `ama`
block overrides the preset field by field; any period the bot does not supply is
taken from the preset named by `gridPrice` (`"ama"` → the pair's `defaultAma`,
which falls back to `AMA3`; `"ama1"`–`"ama4"` → that exact preset); and any
remaining missing field falls back to the built-in `MARKET_ADAPTER.AMAS` defaults
(`modules/constants.ts`, default key `AMA3`). A bot that hand-writes any of the
three periods is reported as `custom` in the adapter state rather than by a preset
name.

### How It Works

1. **Market Adapter** (`market_adapter/market_adapter.ts`) runs continuously
2. Loads per-bot AMA configuration (or uses defaults)
3. Calculates AMA from 1h candlestick closing prices
4. Tracks the **AMA center price** for each bot
5. When `|currentAMA - lastRecordedAMA| >= AMA_DELTA_THRESHOLD_PERCENT`:
   - **Checks if the bot is whitelisted** (non-whitelisted bots only log results)
   - Persists `profiles/orders/<botKey>.dynamicgrid.json`
   - Creates `profiles/recalculate.<botKey>.trigger` file
   - DEXBot detects the trigger at startup or through `fs.watch` and runs a full grid resync under `_fillProcessingLock`
6. Last recorded center is updated only after the dynamic-grid snapshot write succeeds

### When to Adjust

**Increase threshold (e.g., 1% → 2%) if:**
- Full grid resyncs happen too frequently (excessive churn)
- Market is choppy/sideways
- You want fewer but larger full resyncs

To change the threshold for every bot, edit `profiles/general.settings.json`
or use the `dexbot bot` general settings menu. To change the AMA preset
used by a specific market, edit `profiles/market_profiles.json`. To change the
fallback bot-level AMA settings, edit the bot entry in `profiles/bots.json`.

**Decrease threshold (e.g., 1% → 0.5%) if:**
- Grid reacts too slowly to market moves
- Market is trending strongly
- You want grid to follow price more closely

---

## 4. AMA Slope Range Reset (Market Adapter)

### What It Does
For bots whitelisted for asymmetric bounds / grid range scaling, the adapter
tracks the AMA slope baseline accepted at the last grid reset. When the slope
delta crosses the configured threshold, the adapter persists the latest range
scaling snapshot, including the live market price offset derived from that
slope, and writes a reset trigger.

**Why it matters:** Range scaling changes grid bounds and the live market/start
price used for initial placement, not just live order weights. Existing orders
need a reset to move to the new asymmetric range and offset placement price.

### Configuration

Range scaling is enabled by the whitelist's `asymmetricBounds: true` flag.
Set it per bot in the editor: `dexbot bot` → `2) Modify bot` → pick the bot →
`6) Adapter` → **Range** = yes. The flag is stored in
`profiles/market_adapter_whitelist.json` next to **Price** (AMA pricing) and
**Weight** (dynamic weights); all three default to off until enabled.

The snapshot fields involved are:

- `amaSlope`: latest slope diagnostic
- `gridRangeScalingAmaSlope`: last accepted grid-reset slope baseline
- `gridPriceOffsetPct`: signed market/start-price offset derived from AMA slope
- `amaSlopeDeltaPercent`: distance from the accepted baseline
- `amaSlopeThresholdPercent`: threshold required to trigger the reset

**Trigger threshold.** By default the reset fires when the slope delta crosses
`AMA_SLOPE_DELTA_THRESHOLD_PERCENT`, a percentage of the AMA max slope
(`(value/100) × maxSlopePct`) — default `8%`, stored under `MARKET_ADAPTER` in
`profiles/general.settings.json` and editable via `dexbot bot` → `1) Grid
Drift` (`AMA-Slope Δ`). An explicit `amaSlopeDeltaThresholdPercent` in
`profiles/market_adapter_settings.json` bypasses the factor and is used
directly as a percent-per-bar threshold (the same unit as the slope value
described below — no averaging is implied by the unit).

**Persistence gate.** The slope-delta trigger is gated by default: it fires only
after `AMA_SLOPE_PERSIST_BARS` (default `3`) consecutive bars cross the threshold
in the same direction, so a 1–2 bar excursion is ignored. A sustained move is
confirmed K bars after onset — up to K−1 bars later than the ungated trigger;
the independent price/Drift trigger is unaffected.
`AMA_SLOPE_PERSIST_ENABLED` (default `true`) is the master switch; a
bot/market can override via `amaSlope.persistBars` (`>= 1` gate length, `0`
disables) or `amaSlope.persistEnabled: false`, which disables the gate for that
bot even while the global switch is on.
Versus the ungated path this cuts resets ~35% and whipsaws (~52%→~17%) with lag
and range tilt unchanged.

AMA slope values are stored and compared in percent per bar. The value itself
is a **Huber-robust linear regression of `ln(AMA)` over the lookback window**
(`DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS`, default `16` bars; `computeHuberWindowSlopePct` in
`market_adapter/core/strategies/dynamic_weight_series.ts`; its tuning lives in
`MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_HUBER`) — a smooth, robust fit whose influence
function is bounded, so one outlier bar cannot drag it, which is what a plain
mean (and the older two-point endpoint difference it is equivalent to) would do.
Because the fit reports the log-return, a reading is ~`ln(1+r)` rather than the
arithmetic `r`: negligible at the sub-0.1 %/bar magnitudes the defaults use, but
~3% lower at a 6%/bar saturation (`ln(1.06)*100 = 5.83`). A pre-existing user
override of `amaSlope.maxSlopePct` or `neutralZonePct` was tuned against the
arithmetic reading, so treat a saturated override as a hair tighter than before.

Changing the estimator changes the stored value: after a deploy, the first
cycle compares a new-algorithm reading against the baseline persisted by the
previous one (`botState.gridRangeScalingAmaSlope`). The magnitudes agree
closely, so the delta stays under the reset gate on ~98% of bars — a rare,
single extra recenter for whitelisted bots. No version marker is persisted to
suppress it. Older
settings that used cumulative percent over the full lookback can either be
divided by `amaSlope.lookbackBars`, or marked with
`"amaSlopePercentMode": "window"` in `profiles/market_adapter_settings.json`
so the adapter converts them when loading overrides. New settings should use
`"amaSlopePercentMode": "perBar"`.

### How It Works

1. Adapter computes the current AMA slope, range-scaling bounds, and market price offset.
2. It compares the current slope with `gridRangeScalingAmaSlope`.
3. If the threshold is crossed and the bot is range-scaling-whitelisted:
   - Persists the dynamic-grid snapshot
   - Writes a trigger with `reason: "market_adapter_ama_slope_delta_threshold"`
   - Advances the accepted slope baseline only after persistence succeeds
4. Direction changes alone do not reset the grid unless the slope delta threshold is crossed.

---

## 5. RMS Structural Divergence (Runtime Maintenance)

### What It Does
Compares the **calculated grid** currently held by the bot with the
**persisted grid state** (ACTIVE on-chain orders plus VIRTUAL planned
reservations). When structural divergence exceeds the threshold, the bot
performs a full grid resync.

**Scope (per side):** the metric covers **ACTIVE + VIRTUAL** orders. PARTIAL
orders are excluded (expected to deviate mid-fill) and SPREAD placeholders are
excluded (size-0). VIRTUAL slots carry the planned reservation for unplaced
rail slots (`funds.virtual`), so a persisted-vs-ideal drift there moves
`Available = ChainFree − Virtual − fees` and is treated as structural.

**Why it matters:** Order fills, rotations, and fee deductions can make the
grid shape drift away from the stored picture. RMS divergence
detects that structural drift. Once it crosses the threshold, DEXBot rebuilds
from the latest market-adapter snapshot instead of trying to keep patching the
old shape.

The RMS calculation compares the runtime grid (calculated from the bot's
config and live dynamic weights) against the persisted grid state
(ACTIVE + VIRTUAL).
Crossing the threshold only changes the follow-up action: the bot refreshes
`gridCenterPrice` from the latest `amaCenterPrice` in `dynamicgrid.json`,
then runs the full resync path.

#### Two RMS trigger paths

Both paths use the same `resetSource: "rms_structural_grid_resync"` and
both refresh the AMA center before rebuilding, but they fire from different
code paths and log differently:

| Path | Fires from | Trigger | Log signature |
|------|-----------|---------|---------------|
| **Periodic divergence** | `dexbot_maintenance_runtime.ts` periodic sync loop | `Grid.monitorDivergence()` reports `buy.rms` or `sell.rms` above threshold | `[RMS] Grid update triggered by structural divergence during periodic: buy=...% sell=...% (threshold=...%) sides=... → TRIGGER-RESYNC (rms_structural_grid_resync)` |
| **Structural recovery (COW guard)** | `dexbot_class.ts` `_wireStructuralGridResyncRequest()` | Order manager detects unmatched chain orders during copy-on-write placement | `[RECOVERY] Running structural full grid resync for <reason> (N unmatched chain order(s))` |

The structural-recovery path is debounced through `_structuralGridResyncTimer`
and dedupes while one resync is already pending or running.

### Configuration

**File:** `profiles/general.settings.json`
```json
{
  "GRID_LIMITS": {
    "GRID_COMPARISON": {
      "RMS_PERCENTAGE": 14.3
    }
  }
}
```

**Parameters:**
- `RMS_PERCENTAGE`: Root Mean Square divergence threshold
  - Default: `14.3%` (balanced)
  - Range: `0` to `100+`
  - Set to `0` to **completely disable RMS checks**

### Threshold Reference Table

| RMS % | Avg Error | Description |
|-------|-----------|-------------|
| 0 | N/A | Disabled (no checks) |
| 4.5% | ~1.0% | Very strict (frequent full resyncs) |
| 9.8% | ~2.2% | Strict |
| **14.3%** | **~3.2%** | **Default (balanced)** |
| 20.1% | ~4.5% | Lenient |
| 31.7% | ~7.1% | Very lenient |
| 44.7% | ~10% | Extremely lenient |

### How It Works

1. **Grid Engine** (`modules/order/grid.ts`) calculates the ideal grid state
2. Compares with the persisted grid state — ACTIVE on-chain orders plus VIRTUAL planned reservations — after fills/rotations
3. Computes RMS divergence metric:
   ```
   RMS = √(mean of ((calculated - persisted) / persisted)²)
   ```
4. If `RMS >= RMS_PERCENTAGE`:
   - Logs the structural divergence metrics
   - Refreshes `gridCenterPrice` in `dynamicgrid.json` from the latest
     `amaCenterPrice`
   - Calls `_performGridResync()` with
     `resetSource: "rms_structural_grid_resync"`
   - Persists the rebuilt grid and records reset metadata in `dynamicgrid.json`
5. Market-adapter state and center projection files import that reset metadata
   on the next adapter cycle

### When to Adjust

**Increase threshold (e.g., 14.3% → 20%) if:**
- Full RMS resyncs happen too frequently
- You're comfortable with more fill/rotation drift
- Blockchain latency causes false positives

**Decrease threshold (e.g., 14.3% → 9.8%) if:**
- You want tighter sync with blockchain state
- You want to catch drift earlier
- Fill/rotation operations are causing noticeable size errors

**Disable (set to 0) if:**
- You want to rely ONLY on AMA triggers
- You want to prevent automatic full resync from divergence alone
- You manually trigger full grid resyncs through other mechanisms

---

## 6. Available-Funds Resize Threshold (Internal)

### What It Does
Monitors available funds on each side (BUY/SELL). When accumulated fill
proceeds exceed the threshold, the bot recalculates order sizes on the affected
side so freed capital is used again.

**Why it matters:** As orders fill, capital is freed. This maintenance path
re-allocates that capital back into active orders instead of leaving it idle.

This is not a market-adapter recenter event. It does not mean the AMA center
changed, and it does not write a market-adapter trigger file.

### Configuration

**File:** `modules/constants.ts`
```javascript
GRID_LIMITS: {
  GRID_REGENERATION_PERCENTAGE: 3,
  // ...
}
```

**Parameters:**
- `GRID_REGENERATION_PERCENTAGE`: Bidirectional threshold for size recalculation (default: `3%`)
  - Grow: free funds accumulate to ≥3% of allocated capital (e.g. availableFunds ≥ 60 BTS on a 2000 BTS grid)
  - Grow (committed drift): the on-chain (ACTIVE/PARTIAL) orders lag their geometric ideal by ≥3% of the committed size — catches an external deposit that the fill/rotation pipeline already folded into `virtual`, which blinds the `availableFunds = chainFree − virtual` ratio
  - Shrink: grid-tracked size (ACTIVE + PARTIAL + VIRTUAL) exceeds allocation by ≥3% (external fund removal resizes affected orders down; per-side chain totals are not used — fills move value across sides)
  - Shrink (committed drift): the on-chain orders exceed their geometric ideal by ≥3% of the committed size (external withdrawal)
- `SIZE_UPDATE_MIN_CHANGE_PERCENT`: per-slot emission gate on the resize path (default: `3%`). A trigger above resizes the side as a whole, but an individual order is only updated on chain when its own ideal-vs-current size difference reaches this threshold. Sub-threshold slots stay untouched in both the working grid and the chain. The resolved value is clamped to `RELATIVE_ORDER_UPDATE_THRESHOLD_PERCENT` so an emission below the commit-time equality tolerance can never be broadcast (such a batch was refused at commit after the ops had already landed on chain). A configured `0` means "smallest safe threshold", not the old one-satoshi behavior; to go below the default 0.1% commit floor, lower both knobs.
  - Trade-off: convergence is per-slot. Many slots each drifting <3% do not trigger a resize even if their cumulative misallocation is large, because no individual UPDATE would be emitted. This is deliberate: sub-threshold churn costs fees without changing the book.
  - The gate is applied to the size **emitted after the funding cap**, not only to the geometric ideal: a cap can clip a significant ideal to a sub-threshold change, which commit would treat as a no-op.
  - Operator-visible change: configuring `RELATIVE_ORDER_UPDATE_THRESHOLD_PERCENT: 0` no longer disables the commit ratio check; it falls back to the `0.1%` default. The emission denominator is `max(current, proposed)`, matching commit, so a change exactly at the threshold is not emitted.

### How It Works

1. **OrderManager** tracks available funds per side (BUY and SELL separately)
2. Allocated capital = number of active orders × size per order
3. When `availableFunds / allocatedCapital × 100 >= GRID_REGENERATION_PERCENTAGE`, OR the committed-drift leg flags the side (on-chain orders ≥threshold off their geometric ideal):
   - Triggers `Grid.recalculateGrid()` on that side only
   - Recalculates order sizes to incorporate freed capital
   - Maintains asymmetric fills (BUY fills don't trigger SELL resize)
   - The committed-drift leg is what keeps a deposit that was absorbed into the VIRTUAL reservation from silently leaving the on-chain side un-resized
4. After the resize, available funds are re-allocated into active orders
5. Mirror (shrink): when `(gridTracked - allocated) / allocated × 100 >= threshold` (external fund removal), the same path resizes affected orders down

### When to Adjust

**Increase threshold (e.g., 3% → 5%) if:**
- Size recalculations happen too frequently
- You want to accumulate more fill proceeds before rebalancing
- You prefer stability over utilization

**Decrease threshold (e.g., 3% → 1%) if:**
- You want to re-utilize capital more aggressively
- You have high fill rates
- Available funds sitting idle bothers you

---

## Interaction Between Mechanisms

### Independence
All reset/update sources are **independent**:
- Initial AMA snapshot reset is triggered by accepting the first AMA center
- AMA delta is triggered by market price changes
- AMA slope reset is triggered by accepted range-scaling slope drift
- RMS structural divergence is triggered by blockchain/grid-shape drift
- Available-funds resize is triggered by accumulated free funds
- Runtime execution is serialized by the fill-processing lock and idle/dust deferral

### Configuration Priority
1. **All mechanisms are independent** — no global priority or suppression
2. Each can be configured and disabled separately
3. Disabling one doesn't affect the others

### Examples

**Example 1: Conservative Grid (Tight Sync)**
```json
{
  "MARKET_ADAPTER": {
    "AMA_DELTA_THRESHOLD_PERCENT": 0.5  // Respond to small moves
  },
  "GRID_LIMITS": {
    "GRID_REGENERATION_PERCENTAGE": 1,  // Reuse freed funds quickly
    "GRID_COMPARISON": {
      "RMS_PERCENTAGE": 9.8  // Tight divergence tolerance
    }
  }
}
```
- Grid follows price closely
- Frequently re-utilizes freed capital
- Detects drift early
- **Cost:** More full resyncs or size recalculations, higher blockchain fees

**Example 2: Aggressive Grid (High Utilization)**
```json
{
  "MARKET_ADAPTER": {
    "AMA_DELTA_THRESHOLD_PERCENT": 2  // Ignore minor moves
  },
  "GRID_LIMITS": {
    "GRID_REGENERATION_PERCENTAGE": 5,  // Accumulate more freed funds first
    "GRID_COMPARISON": {
      "RMS_PERCENTAGE": 0  // Disable RMS checks
    }
  }
}
```
- Grid adapts only to major price moves
- Accumulates capital before rebalancing
- No automatic drift correction
- **Benefit:** Fewer full resyncs and size recalculations, lower fees

**Example 3: Balanced (Default)**
```json
{
  "MARKET_ADAPTER": {
    "AMA_DELTA_THRESHOLD_PERCENT": 1.0  // Default threshold
  },
  "GRID_LIMITS": {
    "GRID_REGENERATION_PERCENTAGE": 3,  // Moderate utilization
    "GRID_COMPARISON": {
      "RMS_PERCENTAGE": 14.3  // Balanced tolerance
    }
  }
}
```
- Default for most bots
- Balances responsiveness and cost
- **Good for:** Normal trading conditions

---

## Debugging: Which Trigger Fired?

Check the logs for these messages:

**AMA Delta Trigger:**
```
TRIGGERED -> profiles/recalculate.<botKey>.trigger
```

Trigger payload reasons:

```text
market_adapter_bootstrap
market_adapter_delta_threshold
market_adapter_ama_slope_delta_threshold
manual_grid_full_reset   # dexbot reset / claw launcher reset / default settings-patch recalc: clean slate, guards cleared
```

**RMS Divergence Trigger:**
```
[RMS] Grid update triggered by structural divergence during periodic: buy=16.20% sell=2.10% (threshold=14.3%) sides=buy → TRIGGER-RESYNC (rms_structural_grid_resync)
Grid regeneration triggered. Performing full grid resync...
Recorded grid reset metadata for dynamic grid state.
```

At `debug` level each tick also emits the per-side check detail (mirroring the `[DIVERGENCE]` ratio-check line):
```
[RMS] BUY check: metric=...% (threshold=14.3%) → TRIGGER-RESYNC/no trigger | SELL check: metric=...% (threshold=14.3%) → TRIGGER-RESYNC/no trigger
```

**Available-Funds Resize Trigger:**
```
Grid update triggered by funds during periodic (buy: ..., sell: ...)
```

**Trigger File Resync Execution:**
```text
Pending trigger file detected. Processing reset before startup...
Grid regeneration triggered. Performing full grid resync...
Removed trigger file.
```

---

## Common Configuration Mistakes

❌ **Don't:** Set `RMS_PERCENTAGE` to 0 without understanding consequences
- Grid will never auto-correct blockchain state drift
- Manual intervention required if major divergence occurs

❌ **Don't:** Set `AMA_DELTA_THRESHOLD_PERCENT` too low (< 0.5%)
- Full grid resyncs happen constantly (high fees)
- May never stabilize in choppy markets

❌ **Don't:** Disable AMA without disabling AMA configuration
- Orphaned `ama` section in bots.json
- Confusing configuration state

✅ **Do:** Understand your market's volatility
- Trending markets: Lower AMA_DELTA_THRESHOLD_PERCENT
- Choppy markets: Raise both AMA_DELTA_THRESHOLD_PERCENT and RMS_PERCENTAGE
- High-fill markets: Lower GRID_REGENERATION_PERCENTAGE

✅ **Do:** Monitor grid update frequency
- Log output should show full resyncs and maintenance resizes are balanced
- Adjust thresholds if too frequent or too rare

---

## References

- `modules/constants.ts` — Default configuration values
- `modules/account_bots.ts` — Bot configuration schema and defaults
- `modules/settings_merge.ts` — Consolidated settings merge (how thresholds actually resolve across general/bot/pair layers)
- `market_adapter/market_adapter.ts` — AMA calculation and trigger logic
- `market_adapter/core/market_adapter_service.ts` — Initial AMA snapshot, AMA-delta, and AMA-slope trigger decisions
- `modules/dexbot_maintenance_runtime.ts` — Trigger-file detection, full-resync center refresh, idle/dust deferral, and reset metadata recording (periodic RMS path)
- `modules/dexbot_class.ts` — `_performGridResync()`, `requestGridReset()`, and COW-guard structural recovery wiring
- `modules/order/grid.ts` — RMS divergence check and grid comparison
- `modules/order/manager.ts` — Available-funds resize threshold logic
- `modules/market_adapter_whitelist.ts` — Whitelist storage/read helpers (the bot editor's `6) Adapter` reads and writes the same file)
- `profiles/general.settings.json` — User-editable configuration
- `profiles/bots.json` — Per-bot configuration including AMA

## Visualizing the AMA Triggers (§3 and §4)

`dexbot tv <bot>` (and `dist/analysis/tradingview/analyze_tradingview.js`) replays the
two market-adapter recentering triggers over the chart's candle history and draws
the accepted grid center, the range that center would own, and one marker per
reset (amber = AMA-price Δ, cyan = AMA-slope Δ, grey = first snapshot). The
thresholds are resolved through the same constants → `general.settings` →
`market_adapter_settings` chain the adapter uses, so the chart shows where the
grid would actually have moved — handy for tuning `AMA_DELTA_THRESHOLD_PERCENT`
and `AMA-Slope Δ` before changing them. Details:
[analysis/tradingview/README.md](../analysis/tradingview/README.md#grid-reset-simulation).

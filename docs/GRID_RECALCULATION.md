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
| **RMS Structural Divergence** | Bot runtime maintenance | Current grid shape diverges from persisted/on-chain grid by RMS threshold | Refresh `gridCenterPrice` from latest `amaCenterPrice`, then run full grid resync | Full grid resync from latest market-adapter snapshot |
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
5. Call `Grid.recalculateGrid()` using fresh open orders from chain (this is runtime resync, not startup reconcile — see [GRID_RECONCILE.md](GRID_RECONCILE.md)).
6. Reset fee-debt bookkeeping, persist the rebuilt grid, record actual reset
   metadata in `dynamicgrid.json`, and remove the trigger file.

Market-adapter triggers carry `source: "market_adapter/market_adapter.ts"` and
an explicit `reason`, so the runtime can record reset provenance such as
`market_adapter_bootstrap`, `market_adapter_delta_threshold`, or
`market_adapter_ama_slope_delta_threshold`. Empty or malformed trigger files
remain supported as manual/legacy resets.

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
    "enabled": true,
    "erPeriod": 10,      // Efficiency Ratio lookback period (candles)
    "fastPeriod": 2,     // Fast smoothing period for trending markets
    "slowPeriod": 30,    // Slow smoothing period for choppy markets
    "erSmoothPeriod": 0  // Optional ER smoothing; 0 disables it
  }
}
```

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
- `enabled`: Whether to track AMA and trigger grid resets (true/false)
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
- `erSmoothPeriod`: Optional DEXBot2 extension that smooths Kaufman's raw Efficiency Ratio before the AMA smoothing constant is calculated
  - `0`: Disabled, raw Kaufman ER is used directly
  - `1`: Effectively no extra smoothing
  - `3` to `5`: Light to moderate damping for faster AMAs that re-center too abruptly
  - Higher values: More stable ER, but delayed trend/chop recognition
  - Values between `0` and `1` are invalid and fall back to the configured default

AMA parameters are resolved exclusively from **presets** (`AMA1`–`AMA4`): a matched
pair profile in `profiles/market_profiles.json` wins, otherwise the built-in defaults
(`MARKET_ADAPTER.AMAS` in `modules/constants.ts`, default key `AMA3`) are used.

`erSmoothPeriod` is not part of canonical Kaufman AMA/KAMA. It is a bot-level
stabilizer for cases where a faster AMA is useful but raw ER spikes cause false
grid re-centering triggers. Market-profile presets still provide `erPeriod`,
`fastPeriod`, and `slowPeriod`; an inline bot `ama.erSmoothPeriod` can be used
with those presets.

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
Generate or update the AMA whitelist with:

```bash
dexbot white
```

This writes `profiles/market_adapter_whitelist.json`. The default generation
enables AMA live writes for new AMA bots, while leaving dynamic weights and
range scaling disabled.

To opt new AMA entries into range scaling:

```bash
dexbot white --asymmetric-bounds
```

To overwrite one existing bot (otherwise preserved):

```bash
dexbot white --asymmetric-bounds --bot <botKey>
```

The snapshot fields involved are:

- `amaSlope`: latest slope diagnostic
- `gridRangeScalingAmaSlope`: last accepted grid-reset slope baseline
- `gridPriceOffsetPct`: signed market/start-price offset derived from AMA slope
- `amaSlopeDeltaPercent`: distance from the accepted baseline
- `amaSlopeThresholdPercent`: threshold required to trigger the reset

AMA slope values are stored and compared as average percent per bar. Older
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
**persisted/on-chain grid state**. When structural divergence exceeds the
threshold, the bot performs a full grid resync.

**Why it matters:** Order fills, rotations, and fee deductions can make the
active grid shape drift away from the stored/on-chain picture. RMS divergence
detects that structural drift. Once it crosses the threshold, DEXBot rebuilds
from the latest market-adapter snapshot instead of trying to keep patching the
old shape.

The RMS calculation compares the runtime grid (calculated from the bot's
config and live dynamic weights) against the persisted/on-chain grid state.
Crossing the threshold only changes the follow-up action: the bot refreshes
`gridCenterPrice` from the latest `amaCenterPrice` in `dynamicgrid.json`,
then runs the full resync path.

#### Two RMS trigger paths

Both paths use the same `resetSource: "rms_structural_grid_resync"` and
both refresh the AMA center before rebuilding, but they fire from different
code paths and log differently:

| Path | Fires from | Trigger | Log signature |
|------|-----------|---------|---------------|
| **Periodic divergence** | `dexbot_maintenance_runtime.ts` periodic sync loop | `Grid.monitorDivergence()` reports `buy.rms` or `sell.rms` above threshold | `Grid update triggered by structural divergence during periodic: buy=..., sell=...` |
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
2. Compares with the actual blockchain grid state after fills/rotations
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
  - Shrink: grid-tracked size (ACTIVE + PARTIAL + VIRTUAL) exceeds allocation by ≥3% (external fund removal resizes affected orders down; per-side chain totals are not used — fills move value across sides)

### How It Works

1. **OrderManager** tracks available funds per side (BUY and SELL separately)
2. Allocated capital = number of active orders × size per order
3. When `availableFunds / allocatedCapital × 100 >= GRID_REGENERATION_PERCENTAGE`:
   - Triggers `Grid.recalculateGrid()` on that side only
   - Recalculates order sizes to incorporate freed capital
   - Maintains asymmetric fills (BUY fills don't trigger SELL resize)
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
```

**RMS Divergence Trigger:**
```
Grid update triggered by structural divergence during periodic: buy=..., sell=...
Grid regeneration triggered. Performing full grid resync...
Recorded grid reset metadata for dynamic grid state.
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
- `modules/market_adapter_whitelist.ts` / `scripts/generate_market_adapter_whitelist.ts` — Whitelist generation backing `dexbot white`
- `profiles/general.settings.json` — User-editable configuration
- `profiles/bots.json` — Per-bot configuration including AMA

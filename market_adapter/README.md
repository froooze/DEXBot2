# Market Adapter

The live signal layer for AMA-priced bots. It reads candles, computes the AMA center price, optionally writes dynamic weights, and creates recalc triggers when a bot accepts its first center, when the center moves far enough, or when whitelisted range-scaling slope drift requires a grid-bound reset. DEXBot2 starts and stops the adapter automatically when active AMA bots exist.

## Contents

- [Big Picture](#big-picture)
- [Quick Start](#quick-start)
- [Grid Price](#grid-price)
- [Grid Range Scaling](#grid-range-scaling)
- [Asymmetric Weight Shift](#asymmetric-weight-shift)
- [Symmetric Weight Shift](#symmetric-weight-shift)
- [Trigger Threshold](#trigger-threshold)
- [Settings and Overrides](#settings-and-overrides)
- [Live Writes and Dry-Run](#live-writes-and-dry-run)
- [Useful Commands](#useful-commands)
- [Troubleshooting](#troubleshooting)
- [Technical Reference](#technical-reference)

## Which section do I need?

| If you want to… | Read this | Key command |
|-----------------|-----------|-------------|
| Enable AMA pricing for a bot | [Quick Start](#quick-start) | `dexbot white` |
| Change how often the grid rebuilds | [Trigger Threshold](#trigger-threshold) | edit `AMA_DELTA_THRESHOLD_PERCENT` |
| Tune buy/sell weight bias | [Asymmetric Weight Shift](#asymmetric-weight-shift) | whitelist `dynamicWeight: true` |
| Widen/tighten grid bounds by trend | [Grid Range Scaling](#grid-range-scaling) | whitelist `asymmetricBounds: true` |
| Override settings for one pair or bot | [Settings and Overrides](#settings-and-overrides) | edit `profiles/market_adapter_settings.json` |
| Run the adapter standalone or test dry-run | [Live Writes and Dry-Run](#live-writes-and-dry-run) | `node dist/market_adapter/market_adapter.js --dryRun` |
| Debug a bot not being processed | [Troubleshooting](#troubleshooting) | `dexbot white` |
| Understand the signal pipeline or module layout | [Technical Reference](#technical-reference) | — |

## Big Picture

The adapter feeds five separate grid controls from the same candle/AMA pipeline:

| Control | Signal | Effect |
|---------|--------|--------|
| Grid price | AMA price | Moves the grid center through bootstrap and delta reset triggers |
| Grid range scaling | AMA slope | Widens the trend side, tightens the opposite bound through whitelisted slope reset triggers |
| Market price offset | AMA slope | Offsets the live market/start price through whitelisted slope reset triggers |
| Asymmetric weight shift | AMA slope + Kalman filter | Biases buy/sell allocation in the trend direction |
| Symmetric weight shift | Volatility | Reduces both buy and sell weights during noisy periods |

In short: AMA price sets the center; AMA slope scales the range and derives the
market price offset; AMA plus Kalman drives directional weight bias; volatility
applies the symmetric penalty.

## Quick Start

### 1. Enable AMA

Set `gridPrice` to `ama`, `ama1`, `ama2`, `ama3`, or `ama4` in
`profiles/bots.json` or through `dexbot bot`. Use `ama` for the pair's
default preset.

`startPrice` selects the candle source:

| `startPrice` | Adapter source |
|--------------|----------------|
| `pool` | Liquidity pool price |
| `book` | Order book mid price (best bid/ask) |
| numeric value | Fixed anchor (skips candle fetching and SMA warmup); used directly as the static seed price |

When fetching candles (`pool` or `book`), the adapter requires a full historical window. The oldest `erPeriod` candles are used for an initial SMA (Simple Moving Average) warmup phase to seed the AMA and establish the first Efficiency Ratio (ER) calculation. See [AMA Warmup Window](#ama-warmup-window--why-candle-length-matters) for technical details.

### 2. Whitelist Live Writes

Generate the whitelist from AMA-enabled bots. Without a whitelist entry, the
adapter still computes state, but live grid snapshots and recalc triggers stay
in dry-run mode.

```bash
dexbot white
```

This writes `profiles/market_adapter_whitelist.json`, where each bot's AMA,
dynamic-weight, and range-scaling flags can be inspected or adjusted.

By default, newly generated entries whitelist AMA pricing only, keeping both
dynamic weights and range scaling (asymmetric bounds) disabled. To opt newly
generated entries into dynamic weights:

```bash
dexbot white --dynamic-weight
```

To opt newly generated entries into range scaling:

```bash
dexbot white --asymmetric-bounds
```

To overwrite an existing entry (existing entries are otherwise preserved):

```bash
dexbot white --dynamic-weight --bot <botKey>
dexbot white --asymmetric-bounds --bot <botKey>
```

`--bot` implies overwrite for that key only; without it, `dexbot white` only adds missing bots.

Remove stale whitelist entries (bots no longer in `bots.json`):

```bash
dexbot white --prune
```

### 3. Start DEXBot2

Start DEXBot2 normally. The bot runtime launches the adapter when needed.

## Grid Price

Grid price is the AMA price used as the grid center. `gridPrice: "ama"` uses
the pair's `defaultAma` from
`profiles/market_profiles.json`. `gridPrice: "ama1"` through
`gridPrice: "ama4"` force a specific preset. If no pair profile matches, the
bot's `ama` block is used as the fallback.

Bots can optionally add `ama.erSmoothPeriod` to smooth Kaufman's raw Efficiency
Ratio before it enters the AMA smoothing-constant formula. The default is `0`,
which disables this DEXBot2 extension and preserves raw Kaufman behavior. Useful
values start around `3` to `5` when a faster AMA is desired but raw ER spikes
cause abrupt grid-center changes.

### Empirical Divergence Risk Management

The adapter uses tiered clamping thresholds to manage inventory risk during extreme price divergence from the AMA trend center. These thresholds are derived from historical pool volatility and replace static 'fit cap' multipliers. The specific clamping limits and exit parameters are calculated per pair and preset using the AMA fitting toolchain:

```bash
node dist/analysis/ama_fitting/optimizer_high_resolution.js --data <lp-file.json>
```

Source: example LP pool, 1h candles, representative historical window.

| AMA preset | 99.9% — 3.29σ | 99.99% — 3.89σ | 99.999% — 4.42σ |
|------------|-------------------:|--------------------:|-------------------------:|
| AMA1 | 1.461x | 1.571x | 1.626x |
| AMA2 | 1.467x | 1.564x | 1.619x |
| **AMA3** | 1.473x | 1.557x | 1.612x |
| AMA4 | 1.479x | 1.546x | 1.601x |

Divergence is calculated as `abs(Price - AMA) / AMA`. Limit exits use the
selected historical divergence tier to protect the bot from extreme price
excursions and prevent runaway inventory accumulation during high-divergence
volatility.

## Grid Range Scaling

AMA slope can scale the rebuilt grid in two linked ways under the same
whitelist gate:

- tilt the configured min/max range toward the trend direction
- offset the live market/start price used for initial placement

This is separate from dynamic buy/sell weighting. Both grid-range effects are
enabled only when `asymmetricBounds: true` is set in
`profiles/market_adapter_whitelist.json`. Range scaling is opt-in: `dexbot white`
generates AMA-only entries by default, so enable it with
`dexbot white --asymmetric-bounds` (new bots) or
`dexbot white --asymmetric-bounds --bot <botKey>` (existing entry).

Technical formula and tuning details are in
[Grid Range Scaling Model](#grid-range-scaling-model).

When range scaling is whitelisted, the adapter persists the accepted slope
baseline in `gridRangeScalingAmaSlope`. A reset trigger is emitted only when
the slope delta crosses the configured threshold; direction changes alone do
not reset the grid.

## Asymmetric Weight Shift

AMA slope plus Kalman filter confirmation can bias the bot's configured
`weightDistribution` in the trend direction. In an uptrend or downtrend, this
can shift allocation toward the side the strategy wants to emphasize while
still starting from the bot's static buy/sell weights.
See [research guide](../analysis/trend_detection/DYNAMIC_WEIGHT_RESEARCH.md).

## Symmetric Weight Shift

Volatility can reduce both buy and sell weights during noisy periods. This is a
shared penalty on both sides, separate from the directional AMA/Kalman bias.
See [research guide](../analysis/trend_detection/DYNAMIC_WEIGHT_RESEARCH.md).

Both weight shifts are controlled separately from AMA pricing. Set
`dynamicWeight: false` in `profiles/market_adapter_whitelist.json` to keep AMA
pricing active but leave buy/sell weights static. Most users should leave the
tuning values alone unless they are fitting or testing strategy parameters.
Technical formula and tuning details are in [Dynamic Weight Model](#dynamic-weight-model).

## Trigger Threshold

The adapter writes a recalc trigger when both conditions are true:

- the AMA center moved more than `AMA_DELTA_THRESHOLD_PERCENT`
- candle data is not stale

Configure the default in `profiles/general.settings.json` or from the
`dexbot bot` general settings menu:

```json
{
  "MARKET_ADAPTER": {
    "AMA_DELTA_THRESHOLD_PERCENT": 1
  }
}
```

## Settings and Overrides

Market-adapter settings resolve in this order:

1. Built-in defaults in `modules/constants.ts`
2. Global overrides in `profiles/general.settings.json` or `dexbot bot`
3. Pair-specific overrides in `profiles/market_profiles.json`
4. Bot-specific overrides in `profiles/market_adapter_settings.json`

### Data and State Location

The adapter keeps candle data and runtime state in a layout that follows where
the profiles dir resolves (`~/.config/dexbot2/profiles` by default for all
installs; a source checkout keeps `<install-root>/profiles` while a populated
profiles dir exists there — `bots.json`, `keys.json`, settings, or launcher
config):

| Install | Data / state dir |
|---------|------------------|
| Source checkout with repo profiles | `<install-root>/market_adapter/data` and `<install-root>/market_adapter/state` |
| Global npm install / fresh source checkout | `<profiles>/market_adapter/data` and `<profiles>/market_adapter/state`, where `<profiles>` defaults to `~/.config/dexbot2/profiles` |

npm packages ship only compiled `dist/market_adapter/`, so state is relocated
under the profiles dir instead of being written into the package dir (which npm
updates wipe and which may be read-only). Both can be overridden:

```bash
export DEXBOT_MARKET_ADAPTER_DATA_DIR=/custom/candle-data
export DEXBOT_MARKET_ADAPTER_STATE_DIR=/custom/adapter-state
```

The `dexbot clear-market-adapter` / `dexbot clear-all` commands and the
`scripts/clear-*.sh` helpers resolve the same dirs (see
[scripts/README.md](../scripts/README.md)).

### Global Overrides

Override any `MARKET_ADAPTER` constant by adding a matching key under `MARKET_ADAPTER` in `profiles/general.settings.json`:

```json
{
  "MARKET_ADAPTER": {
    "AMA_DELTA_THRESHOLD_PERCENT": 2.0,
    "DYNAMIC_WEIGHT_CLIP_PERCENTILE": 5
  }
}
```

### Pair-Specific Overrides

Pair-specific AMA profiles live in `profiles/market_profiles.json`:

```json
{
  "version": 1,
  "profiles": [{
    "key": "EXAMPLE-BOT",
    "assetA": "IOB.XRP",
    "assetB": "BTS",
    "intervalSeconds": 3600,
    "defaultAma": "AMA1",
    "amas": {
      "AMA1": { "erPeriod": 200, "fastPeriod": 3, "slowPeriod": 80 },
      "AMA2": { "erPeriod": 500, "fastPeriod": 5, "slowPeriod": 120 }
    }
  }]
}
```

`profiles/market_adapter_settings.json` layers:

```json
{
  "globals": {
    "deltaThresholdPercent": 2.0,
    "regimeSensitivity": 1.0
  },
  "pairs": [{
    "assetASymbol": "IOB.XRP",
    "assetBSymbol": "BTS",
    "marketAdapterSettings": {
      "deltaThresholdPercent": 3.0,
      "amaSlope": { "maxSlopePct": 1.2 }
    }
  }]
}
```

- `globals` — applies to every market and bot
- `pairs[].marketAdapterSettings` — overrides one market pair

### Per-Bot Overrides

`botOverrides` is a general per-bot override within each pair entry. It applies at the highest priority and can hold any supported field:

```json
{
  "pairs": [{
    "assetASymbol": "IOB.XRP",
    "assetBSymbol": "BTS",
    "botOverrides": {
      "EXAMPLE-BOT": {
        "deltaThresholdPercent": 4.0,
        "defaultAmaKey": "AMA1"
      }
    }
  }]
}
```

## Live Writes and Dry-Run

The whitelist controls what the adapter may write. Non-whitelisted bots are
still processed, but live grid files and recalc triggers are suppressed.

| Invocation | Behavior |
|---|---|
| `node dist/market_adapter/market_adapter.js` | Whitelisted bots write live files; others dry-run |
| `node dist/market_adapter/market_adapter.js --dryRun` | All bots dry-run |
| `node dist/market_adapter/market_adapter.js --whitelist-all` | All AMA bots write live files |

Dry-run log lines include `[DRY RUN]` or `[suppressed, dry-run]`.

## Useful Commands

| Task | Command |
|------|---------|
| Generate whitelist | `dexbot white` |
| Opt new whitelist entries into dynamic weights | `dexbot white --dynamic-weight` |
| Opt new whitelist entries into range scaling | `dexbot white --asymmetric-bounds` |
| Overwrite existing entry for a specific bot | `dexbot white --dynamic-weight --bot <botKey>` \| `dexbot white --asymmetric-bounds --bot <botKey>` |
| Prune stale whitelist entries (bots removed from bots.json) | `dexbot white --prune` |
| Probe public CEX availability | `node dist/market_adapter/inputs/fetch_cex_synthetic_data.js --exchange auto --check-only` |
| Seed synthetic cross candles | `node dist/market_adapter/inputs/fetch_cex_synthetic_data.js --exchange auto --bot-key <bot-key>` |
| Run one adapter cycle | `node dist/market_adapter/market_adapter.js --once` |
| Run one cycle with threshold override | `node dist/market_adapter/market_adapter.js --once --deltaPercent 1.5` |
| Run continuously | `node dist/market_adapter/market_adapter.js` |
| Print one-cycle JSON signals | `node dist/market_adapter/ama_signal_runner.js` |
| Print one bot's compact signal output | `node dist/market_adapter/ama_signal_runner.js --bot <botKey> --compact` |

`--deltaPercent` changes the threshold only for that run.

The public CEX synthetic importer uses only the exchanges that passed the live
depth test for the requested cross. It ranks them by the historical depth their
public candle APIs return for the probe window, filters out sources that do
not meet the market-adapter seed requirement, and then seeds the file with a
synthetic cross built from two public `USDT` legs on the best usable exchange.
Some exchanges expose alternate market names for the same underlying asset;
the importer normalizes those aliases automatically.

The seed depth is calculated from the effective AMA configuration when a bot
identity is provided, so the generated file has enough candles for that
runtime configuration. The adapter only reads the exact
`market_adapter_<botKey>_<interval>.json` file, so the generated seed must
match the bot's eventual `botKey`.

## Troubleshooting

### Bot is not processed

- Confirm `gridPrice` is `ama`, `ama1`, `ama2`, `ama3`, or `ama4`.
- Regenerate the whitelist with `dexbot white`.
- Confirm the expected `botKey` exists in `profiles/market_adapter_whitelist.json`.
- If `startPrice` is numeric, the adapter will not fetch pool/book candles for that bot. Use `startPrice` only for a fixed anchor in that case; `gridPrice` remains a separate grid setting.

### Trigger is not created

- Check `lastDeltaPercent` vs `thresholdPercent`.
- Check `staleData` and `staleAgeHours`.
- **Confirm the bot is whitelisted.** Non-whitelisted bots only log and do not write triggers.
- Confirm the bot's whitelist entry has `"ama": true`.
- Run `node dist/market_adapter/market_adapter.js --once --deltaPercent <lower-value>` for a one-cycle threshold test.

### Trigger fires too often

- Increase `MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT`.
- Inspect `lastDeltaPercent` to see the normal movement range for the pair.

### Adapter will not start

- Check for an old lock file at `market_adapter/state/market_adapter.lock`.
- If the adapter is not running and the lock is from a crashed process, remove
  the stale lock file manually.
- If you are using the direct bot launcher, make sure at least one active bot
  has `gridPrice` set to `ama`, `ama1`, `ama2`, `ama3`, or `ama4`.
- If you are using PM2, confirm that `dexbot-adapter` exists in the PM2 app
  list.

## Related Tools

Export candles and charts:

```bash
node dist/market_adapter/inputs/fetch_lp_data.js --pool <poolId> --precA <precA> --precB <precB> --interval 1h --lookback 8760h
node dist/market_adapter/inputs/fetch_lp_data.js --pool <poolId> --precA <precA> --precB <precB> --interval 1h --start <start-date> --end <end-date>
npm run lp:chart -- --data market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json
```

Research and calibration:

```bash
node dist/analysis/analyze_dynamic_weight.js --file market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json
node dist/analysis/analyze_volatility.js --file market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json
node dist/analysis/ama_fitting/calibrate_convergence_er.js --data market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json
```

More tools:

- [Analysis](../analysis/README.md)
- [Scripts](../scripts/README.md)

## Technical Reference

This section keeps the full market adapter details in one place. Normal
operation should follow the Quick Start above.

### Purpose and Boundaries

The market adapter bridges historical analysis and live bot operation. It keeps
fresh market candles per bot, computes the AMA-based market center, evaluates
trend and volatility signals, writes dynamic weight snapshots, and emits recalc
triggers when the grid should be rebuilt.

For the similar bot-scoped debt workflow and collateral advisory path, see
[MPA and Credit Usage](../docs/MPA_CREDIT_USAGE.md).

The adapter runs independently from `dexbot.ts`. It does not place orders,
manage bot lifecycle, or edit bot configuration. Order execution and grid
rebuilds stay owned by the bot runtime.

Standalone daemon mode is still available for direct inspection or manual
operation:

```bash
node dist/market_adapter/market_adapter.js
```

The adapter acts only on closed 1h candles. It can poll more often, but live
updates wait for the next completed candle.

### Signal Pipeline

```text
price_candles -> market_adapter -> AMA -> grid center

AMA slope      -> grid range scaling
AMA slope      -> directional trend channel
Kalman signal  -> trend confirmation channel
ATR            -> symmetric volatility penalty
trend + ATR    -> dynamic buy/sell weights

trend regime   -> advisory collateral-ratio hint
first AMA center -> recalculate.<botKey>.trigger for bootstrap
AMA delta      -> recalculate.<botKey>.trigger
AMA slope delta -> recalculate.<botKey>.trigger for grid range scaling bots
```

Per cycle, per processed bot, the adapter can produce:

| Output | Meaning |
|--------|---------|
| `gridCenterPrice` | AMA-derived grid center, clamped to bounds |
| `weights` | Dynamic `{ buy, sell }` grid weights |
| `trend` | `UP`, `DOWN`, or `NEUTRAL` |
| `atr` / `weightVariance` | Volatility diagnostics |
| `dynamicWeights` | Runtime payload with effective weights and range-scaling diagnostics |
| `collateralRecommendation` | Advisory collateral-ratio hint |
| `recalculate.<botKey>.trigger` | Runtime signal for grid rebuild |

### Runtime Flow

1. Load active bots from `profiles/bots.json`.
2. Select bots with `gridPrice` set to `ama`, `ama1`, `ama2`, `ama3`, or `ama4`.
3. Resolve AMA settings from `profiles/market_profiles.json`.
4. Read `startPrice` to choose the candle source: `pool`, `book`, or fixed.
5. Sync candle data from Kibana or native BitShares data, using the selected source.
6. Repair missing candle gaps: auto-fill gaps ≤24 candles directly (no Kibana), query Kibana only for gaps beyond that threshold. Kibana returning empty is treated as verified no-trade. Writes are suppressed while gaps remain unresolved.
7. Ignore still-forming 1h candles.
8. Compute AMA center, trend, ATR, weights, and collateral hint.
9. Persist the first accepted center, compare center delta, and compare whitelisted range-scaling slope delta.
10. Suppress live writes if the bot is not whitelisted or candle data is stale.
11. Write `dynamicgrid.json` and a recalc trigger for bootstrap, AMA-center threshold, or grid-range-scaling AMA-slope threshold events.
12. Persist state snapshots under `market_adapter/state/`.

### Files

<details><summary>Config and state files (click to expand)</summary>

| File | Purpose |
|------|---------|
| `profiles/bots.json` | Active bots, symbols, pool IDs, and `gridPrice` settings |
| `profiles/market_profiles.json` | Pair AMA profiles and defaults |
| `profiles/market_adapter_whitelist.json` | Per-bot live-write permissions |
| `profiles/market_adapter_settings.json` | Advanced adapter and dynamic-weight tuning |
| `profiles/general.settings.json` | Global market adapter threshold settings |
| `market_adapter/state/market_adapter_state.json` | Full runtime state and diagnostics |
| `market_adapter/state/market_adapter_centers.json` | Lightweight center-price snapshot |
| `profiles/logs/market_adapter.log` | Standalone adapter runtime log |

</details>

### What the Adapter Writes

During normal operation, the adapter may write:

| File | Purpose |
|------|---------|
| `profiles/orders/<botKey>.dynamicgrid.json` | Persisted AMA center snapshot, AMA slope diagnostics, and optional dynamic weights used by the bot runtime |
| `profiles/recalculate.<botKey>.trigger` | Signal for `dexbot.ts` to rebuild the grid |
| `market_adapter/state/market_adapter_state.json` | Full runtime state and diagnostics |
| `market_adapter/state/market_adapter_centers.json` | Lightweight center-price snapshot |
| `market_adapter/data/` | Candle caches and exported LP data |
| `profiles/logs/market_adapter.log` | Standalone adapter runtime log |

`dexbot.ts` consumes the recalc trigger and handles the grid rebuild. The market
adapter does not place orders, start bots, stop bots, or edit
`profiles/bots.json`.

### Dynamic Grid Snapshot

`profiles/orders/<botKey>.dynamicgrid.json` is the live snapshot that the bot
runtime reloads on selected rebalance and maintenance paths. It is written with
the current AMA-derived center and, when enabled, the live dynamic-weight
payload.

Typical fields:

```json
{
  "gridCenterPrice": 1294.6,
  "centerPrice": 1294.6,
  "amaCenterPrice": 1294.6,
  "amaSlope": {
    "trend": "UP",
    "slopePct": 0.04,
    "slopeOffset": 0.16
  },
  "gridPriceOffsetPct": 0.8,
  "amaSlopeDeltaPercent": 0.015,
  "amaSlopeThresholdPercent": 0.015,
  "updatedAt": "2026-03-01T00:00:00.000Z",
  "source": "market_adapter/market_adapter.ts",
  "dynamicWeights": {
    "effectiveWeights": { "sell": 0.45, "buy": 0.55 },
    "baseWeights": { "sell": 0.5, "buy": 0.5 },
    "isReady": true
  }
}
```

- `gridCenterPrice` is the persisted grid baseline used for future delta checks.
- `centerPrice` remains as a compatibility alias for older readers.
- `amaCenterPrice` is the raw AMA output before downstream handling.
- `amaSlope` is the latest AMA slope snapshot used for diagnostics and snapshot writes.
- `gridPriceOffsetPct` is the signed market/start-price offset derived from AMA slope and capped at half of `targetSpreadPercent`; it is not applied to `gridCenterPrice`.
- `gridRangeScalingAmaSlope` in adapter state is the last grid-reset slope baseline used for slope-triggered range-scaling resets.
- `amaSlopeDeltaPercent` records the change from the last grid-reset slope baseline.
- `amaSlopeThresholdPercent` is the configured slope-reset threshold.
- `amaSlope.trend` records the current direction; direction changes do not trigger resets unless the slope delta threshold is crossed.
- During a full grid reset, the bot refreshes `gridCenterPrice` from the latest
  `amaCenterPrice` before rebuilding the grid.
- `dynamicWeights` is present only when live dynamic weights were computed and
  the bot is allowed to consume them.
- The runtime applies `dynamicWeights` only when the bot is whitelisted for
  `dynamicWeight` and the snapshot reports `isReady: true`.
- The bot reads this snapshot before fill processing and other selected
  structural maintenance so new orders use the latest accepted center and
  weights.

### Module Map

<details><summary>Directory layout (click to expand)</summary>

```text
market_adapter/
|-- market_adapter.ts              main adapter daemon
|-- ama_signal_runner.ts           one-cycle JSON signal CLI
|-- candle_utils.ts                candle transforms, gap detection, pruning
|-- interval_utils.ts              shared interval label helpers
|-- lp_chart_core.ts               chart HTML renderer
|-- lp_chart_strategy_loader.ts    AMA strategy/profile resolver for charts
|-- lp_chart_runner.ts             LP chart orchestration
|-- log_format.ts                  adapter startup and signal log formatting
|-- test_helpers.ts                test utilities
|-- core/
|   |-- asymmetric_bounds.ts       AMA-slope range scaling helpers
|   |-- market_adapter_service.ts  full signal pipeline service
|   |-- config_normalizers.ts      shared config normalization
|   |-- kibana_client.ts           low-level Kibana/ES query client
|   |-- kibana_candles.ts          LP pool candle fetch engine
|   |-- kibana_market_candles.ts   book candle fetch and transform
|   |-- signals/
|   |   |-- hurst_analyzer.ts               Hurst Exponent analysis
|   |   |-- kalman_trend_analyzer.ts        Kalman trend state tracking
|   |   |-- kalman_velocity_smoothing.ts    Adaptive Kalman velocity smoothing
|   |   `-- permutation_entropy_analyzer.ts Permutation Entropy analysis
|   `-- strategies/
|       |-- ama.ts                 Kaufman's Adaptive Moving Average (KAMA)
|       |-- ama_slope_model.ts     AMA slope and trend weight logic
|       |-- collateral_manager.ts  advisory collateral-ratio logic
|       |-- dynamic_weight_series.ts  canonical per-bar AMA/Kalman offset pipeline
|       |-- regime_gate.ts         regime multiplier gating
|       |-- regime_interp.ts       regime table bilinear interpolation
|       |-- volatility_shift.ts    symmetric ATR volatility penalty
|       `-- atr/calculator.ts      ATR calculation
|-- inputs/
|   |-- kibana_source.ts           Elasticsearch LP data source
|   |-- fetch_lp_data.ts           historical LP candle exporter
|   `-- fetch_cex_synthetic_data.ts  public CEX synthetic-candle seed importer
|-- utils/
|   |-- chain.ts                   blockchain query helpers
|   |-- adapter_client.ts          inter-process credential daemon client
|   |-- native_history.ts          native BitShares market history fetch
|   |-- file_lock.ts               single-instance file lock
|   |-- data_discovery.ts          data directory auto-discovery
|   |-- atomic_write.ts            atomic file write utility
|   |-- dynamic_grid_snapshot.ts   dynamic grid snapshot helpers
|-- data/                          runtime candle caches and exports
`-- state/                         runtime state, centers, and lock file
```

</details>

### Whitelist Semantics

`profiles/market_adapter_whitelist.json` controls live writes:

```json
{
  "whitelist": {
    "<botKey>": {
      "ama": true,
      "dynamicWeight": false,
      "asymmetricBounds": false
    }
  }
}
```

- `ama: true` allows live `dynamicgrid.json` and recalc trigger writes.
- `dynamicWeight: true` allows dynamic weights to be applied by the bot runtime,
  but only when the snapshot is also marked ready.
- `asymmetricBounds: true` allows AMA-slope grid range scaling during grid rebuilds.
  Runtime code reports this as `gridRangeScalingWhitelisted`; the whitelist key
  remains `asymmetricBounds` for compatibility.
- Omitted whitelist flags are treated as `false`.
- Missing whitelist file means all live AMA writes are suppressed.
- Missing bot entry means that bot runs in dry-run mode.

### Grid Range Scaling Model

Grid range scaling is the technical path for:

```text
AMA slope -> min/max bound tilt
AMA slope -> live market/start-price offset, capped at half spread
```

During a grid rebuild, the bot loads the latest dynamic grid snapshot and uses
the AMA slope diagnostics to tilt the configured `minPrice` and `maxPrice`
around the AMA center. An uptrend widens the upper bound and tightens the lower
bound; a downtrend widens the lower bound and tightens the upper bound.

The same `asymmetricBounds` whitelist also enables `gridPriceOffsetPct`: a
slope-ratio offset applied only to the live `startPrice` used for initial
placement. It is capped at half of `targetSpreadPercent` (`2` allows `-1%` to
`+1%`) and does not change `gridCenterPrice`, the AMA center, or reset
threshold baselines.

This uses `dynamicWeights.trend`, `dynamicWeights.slopeOffset`, and
`dynamicWeights.maxSlopeOffset`, but it is separate from the dynamic buy/sell
weight shift. The whitelist flag is `asymmetricBounds`.

```
slope = average AMA slope percent per bar over the lookback window
slopeOffset = slope normalized to the configured dynamic-weight slope cap
asymmetry = min(|slopeOffset| / maxSlopeOffset, 1) × maxAsymmetryFactor

Downtrend: minPrice = center / (M × (1 + asymmetry))
           maxPrice = center × (M × (1 - asymmetry))

Uptrend:   maxPrice = center × (M × (1 + asymmetry))
           minPrice = center / (M × (1 - asymmetry))

Neutral:   symmetric bounds (asymmetry = 0)
```

`ASYMMETRIC_BOUNDS_MAX_ASYMMETRY_FACTOR` defaults to `0.35`; `0` disables the
tilt. `ASYMMETRIC_BOUNDS_MIN_SCALE_SLOTS` defaults to `10` and sets the minimum
number of price levels the *tightened* side of a range-scaled grid must keep
between the grid center and its bound (measured in `incrementPercent` steps);
`0` disables the guard. Together they keep the widened side aggressively
extended while guaranteeing the narrowed side never collapses into a near-center
sliver with few or no active orders.

Both are configurable per bot or per market via
`profiles/market_adapter_settings.json` (see the layering in
[Per-Bot Overrides](#per-bot-overrides)):

```json
{
  "globals": {
    "asymmetricBounds": {
      "maxAsymmetryFactor": 0.35,
      "minScaleSlots": 10
    }
  },
  "pairs": [{
    "assetASymbol": "IOB.XRP",
    "assetBSymbol": "BTS",
    "marketAdapterSettings": {
      "asymmetricBounds": { "minScaleSlots": 3 }
    }
  }]
}
```

`asymmetricBounds` is merged per-field across the `globals` → `pairs[].marketAdapterSettings` →
`pairs[].botOverrides.<bot>` layers, so overriding one field (e.g. a market-level
`minScaleSlots`) does not wipe another (e.g. a bot-level `maxAsymmetryFactor`).

### Trigger Files

When the threshold is exceeded, the adapter writes a trigger file under
`profiles/` at the repo root:

- `profiles/recalculate.<botKey>.trigger`

The file contains a trigger payload like:

```json
{
  "createdAt": "2026-03-01T00:00:00.000Z",
  "source": "market_adapter/market_adapter.ts",
  "botName": "<botName>",
  "botKey": "<botKey>",
  "thresholdPercent": 0.8,
  "deltaPercent": 1.1,
  "previousCenterPrice": 1280.5,
  "newCenterPrice": 1348.32,
  "referencePrice": 1294.6,
  "amaCenterPrice": 1294.6,
  "poolId": "<poolId>"
}
```

`dexbot.ts` watches for this file and rebuilds the affected grid from current
runtime state. The trigger is separate from `dynamicgrid.json`: the trigger
requests a rebuild, while the snapshot carries the center and live weight state
that the runtime can reload.

### Dynamic Weight Model

Dynamic weights start from the bot's configured `weightDistribution`. These
configured values are the static baseline.

The production dynamic-weight output combines:

| Branch | Role |
|--------|------|
| AMA slope | Measures filtered market direction and velocity |
| Kalman signal | Confirms directional movement |
| ATR volatility | Applies a symmetric risk penalty to both sides |
| Regime gates | Suppress weak or noisy signals |

On each closed-candle cycle, the adapter applies two adjustments:

| Adjustment | Signal | Formula effect |
|------------|--------|----------------|
| `trendOffset` | AMA slope + Kalman confirmation | Subtracts from sell, adds to buy |
| `volatilityPenalty` | Volatility | Adds the same normally negative value to both sides |

```text
effectiveSell = staticSell - trendOffset + volatilityPenalty
effectiveBuy  = staticBuy  + trendOffset + volatilityPenalty
```

A positive `trendOffset` shifts weight toward buy and away from sell. A
negative `trendOffset` shifts weight toward sell and away from buy. The final
values are clamped and rounded before being written to the dynamic grid
snapshot.

Main override knobs live in `profiles/market_adapter_settings.json`:

<details><summary>Full settings table (click to expand)</summary>

| Setting | Meaning |
|---------|---------|
| `alpha` | AMA vs Kalman blend |
| `dw` | Kalman displacement weighting |
| `gain` | Output amplitude |
| `amaSlopePercentMode` | Slope override units: `perBar` for average percent per bar, or `window`/unset for legacy cumulative percent over the lookback |
| `amaSlope.lookbackBars` | AMA slope lookback; slope is averaged per bar over this window |
| `amaSlope.neutralZonePct` | Dead band around flat average AMA slope |
| `amaSlope.maxSlopePct` | Average AMA slope saturation |
| `amaSlopeDeltaThresholdPercent` | Average AMA slope delta threshold for slope-based resets |
| `minOutputThreshold` | Minimum trend output before directional shift applies |
| `maxSlopeOffset` | Cap for asymmetric trend offset |
| `maxVolatilityOffset` | Cap for symmetric ATR penalty |
| `clipPercentile` | Outlier filter for AMA/Kalman velocity (clips top N% of values) |
| `absoluteThreshold` | Dead band before regime filtering |
| `atrPeriod` | ATR lookback |
| `volatilityExponent` | ATR penalty exponent |
| `volatilityScaleX` | ATR penalty scale |
| `volatilityThreshold` | Minimum volatility penalty before applying shift |
| `kalmanSmoothPct` | Raw vs smoothed Kalman blend |
| `dispScaleMinPct` | Kalman displacement minimum scale floor |
| `kalmanDispScaleMult` | Kalman displacement scale multiplier |
| `kalmanDispThresholdMult` | Kalman displacement threshold multiplier |
| `kalmanSlope.maxSlopePct` | Kalman slope saturation |
| `kalmanSmoothSpanPct` | Adaptive EMA span ratio |
| `signalConfirmBars` | Signal latch confirmation bars |
| `hurstZoneBand` | Hurst neutral-zone width for regime classification |
| `peNodes` | Permutation Entropy thresholds for regime classification |
| `regimeTable` | Custom 3×3 regime multiplier table |
| `kibanaRequestTimeoutMs` | Kibana request timeout in milliseconds |
| `staleTailThreshold` | Stale-tail pruning threshold in candles |
| `maxNativeGapFillCandles` | Max missing-candle gaps auto-filled without a Kibana query |

</details>

When migrating older settings, either divide AMA slope percent overrides by
`amaSlope.lookbackBars`, or add `"amaSlopePercentMode": "window"` and let the
adapter convert them at load time. New settings should use
`"amaSlopePercentMode": "perBar"` so small per-bar values are not converted
again by pair or bot overrides.

Most operators should tune only the price and slope trigger thresholds plus the AMA profile unless
they are deliberately fitting a market.

See also [research guide](../analysis/trend_detection/DYNAMIC_WEIGHT_RESEARCH.md).

### Candle and Staleness Handling

The adapter keeps candle caches current using Kibana bootstrap plus native
incremental updates. Missing candle gaps are repaired in two steps: (1)
**auto-fill** gaps ≤24 candles (trusted threshold) by carrying the preceding
close forward with zero volume — Kibana is redundant since native fetch already
confirmed no trades; (2) **Kibana query** for gaps >24 candles — real candles
are merged in, or an empty response is treated as verified no-trade (all gaps
in the queried window are synthesized). Gaps remaining after both steps
suppress writes via `unresolved_candle_gaps` until repaired on a future cycle.
The adapter prunes old candles to the required AMA window and acts only on
closed 1h candles.

#### Shared Chunk Cache and Fetch Robustness

Pool, book, and feed candle fetches share one cache entry point (`runCachedWindows` in `market_adapter/inputs/window_cache.ts`): sibling chunk files load once, only missing buckets plus a bounded 48h tail refresh are queried, and chunk metas record the ranges actually queried (`meta.queriedRanges`). A missing range is pruned only when recorded query coverage genuinely covers it — the absence of local buckets alone never certifies history as empty. Partial windows merge into the run output but are never persisted, and orphan chunks are deleted after complete runs only. Every range fetch runs through `fetchRangeWithRetry` (per-range attempts + linear backoff + abort-signal timeout; the LP path keeps a 4-attempt budget), one-shot Kibana queries retry transient errors (3 attempts), paged fetchers cap at `kibanaMaxPages` (500), and bidirectional fetches tolerate a one-direction failure.

#### AMA Warmup Window — Why Candle Length Matters

The AMA is a recursive (infinite impulse response) filter. On cold start, the adapter uses an initial warmup phase: it calculates an **SMA (Simple Moving Average)** over the first `erPeriod` candles to establish a stable seed price, while simultaneously building the price history needed to calculate the first valid Efficiency Ratio (ER).

Starting the recursive AMA formula from this SMA, rather than a single raw closing price, provides a more stable anchor. However, a residual initialization bias still exists and decays asymptotically — each bar, the AMA "forgets" a fraction equal to its smoothing constant:

```
bias_remaining(K) ≈ bias_initial × ∏ (1 − SC_i)      for i = 1..K
```

Kaufman's smoothing constant is the ER-scaled value, squared:

```
SC_i = [ER_effective_i × (fastSC − slowSC) + slowSC]²

where  fastSC = 2 / (fastPeriod + 1)
      slowSC = 2 / (slowPeriod + 1)
```

By default, `ER_effective_i` is Kaufman's raw `ER_i`. If `ama.erSmoothPeriod`
or `MARKET_ADAPTER.AMA_ER_SMOOTH_FAST_PERIOD` is set to `1` or higher, DEXBot2
first applies EMA smoothing to the ER stream:

```
ER_effective_i = ER_effective_(i-1) + erSmoothAlpha × (ER_i − ER_effective_(i-1))

where  erSmoothAlpha = 2 / (erSmoothPeriod + 1)
```

This ER smoothing is not part of canonical Kaufman AMA/KAMA. It is an optional
DEXBot2 stabilizer for fast AMAs: it can reduce false or jerky re-centering
caused by one-window ER spikes, at the cost of slower recognition when the
market genuinely changes regime. `erSmoothPeriod = 0` disables it; `1` is
effectively no extra smoothing; `3` to `5` are typical light/moderate values.

Because `ER_i` varies bar-by-bar, a **typical-market ER** (`ER_avg`) is used to
estimate an average decay rate:

```
SC_avg = [ER_avg × (fastSC − slowSC) + slowSC]²
```

Bars needed to reduce bias below a target fraction ε:

```
convergenceBars = ln(ε) / ln(1 − SC_avg)
```

The adapter keeps the **full warmup window** in candle history so the AMA seed
and convergence bias are retained for downstream calculations:

```
amaWarmupBars = erPeriod + convergenceBars + erSmoothConvergenceBars + lookbackBars
```

| Component | Role |
|-----------|------|
| `erPeriod` | Bars for the first Efficiency Ratio value to become available |
| `convergenceBars` | Bars to decay 99 % of the cold-start initialisation bias |
| `erSmoothConvergenceBars` | Extra ER EMA convergence bars when `erSmoothPeriod >= 1`; `0` when ER smoothing is disabled |
| `lookbackBars` | Extra lookback for slope/trend analysis (AMA slope, ATR) |

For **AMA slope readiness and percentile clipping**, the earlier gate is:

```
amaSlopeReadyBars = erPeriod + lookbackBars
```

That threshold is enough once the ER window exists and the lookback comparison
bar is available. The longer `amaWarmupBars` window is still retained so the
underlying AMA series has its full convergence history.

The two **calibration constants** live in `modules/constants.ts` under
`MARKET_ADAPTER`:

| Constant | Value | Meaning |
|----------|-------|---------|
| `AMA_CONVERGENCE_ER_AVG` | `0.151` | Typical-market Efficiency Ratio. Lower = more conservative (assumes more noise, slower convergence, more candles needed). Calibrated against the fetched 3-year pool 133 1h dataset (`2023-05-07` -> `2026-05-06`); corrects for Jensen's inequality — `E[f(ER)] ≠ f(E[ER])` when `f` is the squaring function. |
| `AMA_CONVERGENCE_EPSILON` | `0.01` | Target remaining bias fraction. `0.01` means 99 % of the initial bias has decayed by the end of the convergence window. |
| `STALE_TAIL_THRESHOLD_CANDLES` | `24` | Trusted no-trade gap threshold. Gaps ≤24 candles are auto-filled without Kibana; gaps beyond query Kibana. Also used as stale-tail pruning threshold. |

To recalibrate `AMA_CONVERGENCE_ER_AVG` against new market data, use the
research script:
```bash
node dist/analysis/ama_fitting/calibrate_convergence_er.js [--data <lp-file.json>] [--amas AMA3,AMA4]
```
See `analysis/ama_fitting/calibrate_convergence_er.ts` for details on the
implied-ER correction (Jensen's inequality).

For a calibrated `AMA_CONVERGENCE_ER_AVG` of `0.151` and
`AMA_CONVERGENCE_EPSILON = 0.01` in 1-hour candles, the full AMA warm-up for
the built-in presets is:

| Preset | Candles | Days |
|--------|---------|------|
| `AMA1` | `1,602` | `66.8` |
| `AMA2` | `1,677` | `69.9` |
| `AMA3` | `1,764` | `73.5` |
| `AMA4` | `1,844` | `76.8` |

These totals include the ER buffer, the convergence window, and the default
9-bar lookback used by the dynamic-weight logic. If the candle timeframe is
not 1 hour, scale the total by the candle duration.

**How `slowPeriod` affects the warm-up:** the estimate blends the smoothing
constant at a typical ER: `SC_avg = (ER_avg · fastSC + (1 − ER_avg) · slowSC)²`
with `slowSC ≈ 2 / slowPeriod` (see `getAmaWarmupBars` in
`market_adapter/core/strategies/ama.ts`). Since `convergenceBars` is
proportional to `1 / SC_avg`, a larger `slowPeriod` extends the warm-up, but
the `ER_avg · fastSC` term bounds `SC_avg` from below, so at the calibrated
average ER the growth is sub-quadratic: doubling `slowPeriod` (84 → 168)
raises the requirement only ~1.4×. The **O(slowPeriod²)** scaling (doubling
quadruples it) applies only in the pure-choppy limit (ER → 0), where
`SC = slowSC²`. For the `AMA3` default (see `MARKET_ADAPTER.AMAS` in
`modules/constants.ts`) the blended estimate is ~974 convergence bars.

If the adapter has fewer candles than the warmup window, the AMA output is too
biased for grid centering and the cycle skips with reason
`ama_warmup_insufficient`.

Stale data suppresses trigger writes. Check `staleData` and `staleAgeHours` in
`market_adapter/state/market_adapter_state.json` when a trigger should have
fired but did not.

### State Files

| File | Contents |
|------|----------|
| `market_adapter/state/market_adapter_state.json` | Full per-bot state, signals, weights, staleness, and diagnostics |
| `market_adapter/state/market_adapter_centers.json` | Compact center-price snapshot |
| `market_adapter/state/market_adapter.lock` | Single-instance runtime lock |

If the adapter crashed and is no longer running, a stale lock file can be
removed manually.

### Monitoring Fields

Important fields in `market_adapter/state/market_adapter_state.json`:

<details><summary>Field reference (click to expand)</summary>

| Field | Meaning |
|-------|---------|
| `meta.updatedAt` | Last completed adapter cycle (ISO timestamp) |
| `meta.metrics.processedBots` | Number of bots evaluated this cycle |
| `meta.metrics.durationMs` | Cycle wall-clock duration in milliseconds |
| `lastCycleAt` | Last cycle timestamp for a bot |
| `lastAmaPrice` | Latest computed AMA price for a bot |
| `gridCenterPrice` | Stored center used for delta comparison |
| `lastDeltaPercent` | Move from stored center to latest AMA |
| `thresholdPercent` | Active recalc trigger threshold |
| `lastTriggerFile` | Last recalc trigger file written (`triggered` is a transient per-cycle return value, not persisted) |
| `lastTriggerSuppressedReason` | Why the last trigger write was suppressed |
| `triggerCount` | Number of triggers written for the bot |
| `staleData` | Whether stale candles suppressed live writes |
| `staleAgeHours` | Age of the newest usable candle |
| `amaSlope.trend` | `UP`, `DOWN`, or `NEUTRAL` |
| `atr` | Average True Range value |
| `weightVariance` | Normalized volatility ratio |
| `weights` | Current dynamic buy/sell weights |
| `collateralRecommendation` | Advisory collateral-ratio hint |
| `kibanaGapRepairCount` | Gaps patched this cycle (auto-fill or Kibana-verified) |
| `unresolvedGapCount` | Gaps still missing after all repair attempts; writes suppressed while > 0 |

</details>

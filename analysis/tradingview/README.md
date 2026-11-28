# TradingView HTML Exporter

This exporter generates a standalone HTML chart in the `analysis/charts/` folder using the local `uPlot`-based TradingView-style renderer. The renderer lives in `analysis/tradingview/tradingview_uplot_chart_generator.ts`; `analysis/tradingview/analyze_tradingview.ts` is the CLI entry point.

## Recommended: `dexbot tv` (One Step)

`dexbot tv` fetches the candles itself (chunked Kibana scans: pools with order-book fallback for pairs) and then renders through this exporter — no manual fetch/export steps needed:

```bash
# Bot chart with AMA overlay (bot key from profiles/bots.json, default: 3 months)
dexbot tv <bot>

# Any pool by bare or full ID
dexbot tv 133
dexbot tv 1.19.133

# Any pair (pool-first, order-book fallback)
dexbot tv TOKENA/TOKENB

# MPA price-feed history instead of market candles (opt-in; MPA/MPA pairs
# cross both feeds into one quote, e.g. HONEST.USD/HONEST.EUR)
dexbot tv BTS/HONEST.USD --feed

# Options
dexbot tv <bot> --month 6              # months of 1h candles (default: 3)
dexbot tv <bot> --chart analysis/charts/custom.html
dexbot tv BTS/HONEST.USD --book # override: order-book fills instead of the pool
```

Output: `analysis/charts/tv_<bot|pool_<id>|<a>_<b>>_1h_<N>m.html`, with a clickable `file://` link printed on completion. Unknown targets fail fast with the list of known bot keys.

The sections below cover manual usage (explicit candle files, direct runner flags).

## What It Produces

- Log-scale price chart
- Candle timeframe buttons: `1h`, `4h`, `1d`, `1w`, `1M`
- Pair-orientation switcher for `A/B` and `B/A`
- SMA overlay
- AMA preset buttons `1–4` (one-click AMA1–4, active preset highlighted); numeric inputs kept
- Bot-grid range highlight, off by default (the bot's min/max around AMA with live asymmetric tilt; red above AMA, green below). `Range` and `Scale` are AMA-derived, so turning one on opts into what it needs: `Range` → `AMA`, `Scale` → `Range` + `AMA`; turning `AMA` off takes `Range` and `Scale` back down with it, so the toggles never sit in a dead state. One-way opt-in is re-applied on load, so a chart saved with `Scale` on renders its band.
- Grid-reset simulation (AMA bots, on by default): replays the market adapter's two recentering triggers over the candle history — the accepted grid center as a step line, the simulated grid range around it, and a marker per reset (`init` = first AMA snapshot, `Δ1` = AMA-price Δ, `Δs` = AMA-slope Δ). Thresholds come from the live config chain; a bottom-left panel shows the values, where they came from, and the reset counts (see [Grid-Reset Simulation](#grid-reset-simulation))
- Range-scale switch: fit the price axis to the range band. Toggling `Range` / `Scale` (or dragging the grid-span slider) keeps the current view — the price axis is not refitted under the cursor; the band-fit applies on the next autofit (reload, timeframe switch, x pan) or immediately on a double-click of the price axis. Opting into `Scale`/`Range` also opts into the indicators they need (see above)
- VWMA overlay
- Order overlay for bot charts (active grid buys/sells as dashed levels, reserve line at the lowest grid buy, ceiling line at the highest grid sell, spread label; pair-aware, toggle in-chart)
- Market panel (top-right): `SELL` / `Market` / `BUY` rows with distance-to-market %
- Range panel (bottom-right, smaller type): visible-window candle High/Low (red/green, mirroring the SELL/BUY badge)
- Volume badge (bottom-right of the volume chart, same small type): visible-window max volume, always with the currency suffix (`1.2M BTS`); click the badge, the legend `Vol` value, or the toolbar unit button to switch base/quote units (quote ≈ base × close, persisted per chart like the AMA settings; feed charts show publish counts and disable the switch)
- Bottom volume panel with `Volume` toggle and per-bar hover tooltip
- Crosshair legend with current candle values
- Live data-age badge next to the title: the age of the newest candle is recomputed every minute in the browser (minutes under an hour, hours and minutes under a day, days and hours beyond), so a chart saved or opened later shows its own staleness — green under 24h, amber 1–7 days, red over a week (unknown when the source carries no candle time or `meta.updatedAt`)

## Quick Start

A chart requires candle data. Either pass an explicit candle file or let the exporter resolve a bot's candles and AMA settings:

```bash
# From an explicit candle JSON file (json source is the default)
npm run analysis:tradingview -- \
  --file market_adapter/data/market_adapter_<bot-key>_1h.json
```

Or with a bot key (see [Bot-Key Usage](#bot-key-usage-recommended) below):

```bash
npm run analysis:tradingview -- \
  --source market_adapter \
  --bot-key <bot-key>
```

This writes:

```text
analysis/charts/tradingview_chart.html
```

> The bare `npm run analysis:tradingview` (no args) errors out — the default `json`
> source requires `--file`, and the `market_adapter` source requires `--bot-key`.

## Bot-Key Usage (Recommended)

The easiest way to generate a chart for a specific bot. Pass the bot key from `profiles/bots.json` and the exporter automatically resolves the candle file and AMA settings:

```bash
npm run analysis:tradingview -- \
  --source market_adapter \
  --bot-key <bot-key>
```

This picks up the bot's asset pair, market profile AMA defaults, and candle data from `market_adapter/data/`. AMA is auto-enabled when the bot uses `gridPrice: "ama"` (or ama1-4).

With a custom chart path:

```bash
npm run analysis:tradingview -- \
  --source market_adapter \
  --bot-key <bot-key> \
  --chart analysis/charts/<pair>_tradingview.html
```

CLI direct equivalent:

```bash
node dist/analysis/tradingview/analyze_tradingview.js \
  --source market_adapter \
  --bot-key <bot-key>
```

### How It Works

1. Reads `profiles/bots.json` to find the bot's `assetA`, `assetB`, and `ama` settings.
2. Resolves the candle file at `market_adapter/data/market_adapter_<bot-key>_1h.json`.
3. Looks up the matching market profile in `profiles/market_profiles.json` for AMA defaults.
4. AMA settings priority: bot-specific `ama` object > market profile > constants (AMA3, slowPeriod 83.5).

> The candle file must exist — run the market adapter LP exporter first if needed (see [Getting Blockchain Data](#getting-blockchain-data)).

## From an Explicit Candle File

```bash
node dist/analysis/tradingview/analyze_tradingview.js \
  --file market_adapter/data/market_adapter_<bot-key>_1h.json \
  --chart analysis/charts/<pair>_tradingview.html
```

Using LP candle files directly:

```bash
node dist/analysis/tradingview/analyze_tradingview.js \
  --file market_adapter/data/lp/<pair-folder>/lp_pool_<id>_<interval>.json \
  --chart analysis/charts/tradingview_chart.html
```

## Input Format

The exporter accepts candle data in either of these shapes:

- Array rows: `[timestamp_ms, open, high, low, close, volume]`
- Object rows: `{ time|timestamp|ts, open, high, low, close, volume }`

If you pass a raw JSON file, the runner normalizes the candles before rendering.

## Getting Blockchain Data

Use the market adapter LP exporter to pull blockchain-backed candles before generating the HTML:

```bash
# Auto mode — resolves pool + precisions from bots.json / blockchain
node dist/market_adapter/inputs/fetch_lp_data.js --bot BTS-USDT --interval 1h --lookback 4392h

# Or with an explicit date range
node dist/market_adapter/inputs/fetch_lp_data.js --bot BTS-USDT --interval 1h --start 2026-02-23 --end 2026-08-23

# Manual mode — no blockchain needed
node dist/market_adapter/inputs/fetch_lp_data.js --pool 133 --precA 4 --precB 5 --interval 1h --lookback 26280h
```

For date range fetching, use `--start` and `--end` (e.g. `--start 2024-03-06 --end 2025-03-06`).

That writes a JSON file under `market_adapter/data/lp/` which you can then pass to the TradingView exporter:

```text
market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json
```

| Flag | Description |
|------|-------------|
| `--bot <bot>` | Bot name from `profiles/bots.json` (auto-resolves pool) |
| `--pool <id>` | Manual mode, no blockchain needed (requires `--precA/--precB`) |
| `--interval <1m\|5m\|15m\|30m\|1h\|2h\|4h\|6h\|12h\|1d\|1w>` | Candle bucket size (bare numbers = seconds, e.g. `1800` = 30m) |
| `--lookback <N>h` | Hours back from now |
| `--start / --end` | Explicit date range (e.g. `2026-02-23`) |
| `--out <path>` | Custom output path |

> **Note:** the fetcher may not exit on its own after printing `Saved:` (the live BitShares WebSocket + node monitor keep the process alive). It is safe to Ctrl+C once the file is saved.

## CLI Flags

Indicator on/off state is not a generation-time flag: `SMA`, `VWMA`, `AMA`, `Range` and `Scale` are in-chart toolbar toggles, persisted per chart in `localStorage`, and `Range` / `Scale` opt into the AMA they are derived from. The `--range`, `--no-range`, `--range-scale` and `--no-ama` flags were removed — they duplicated the toolbar and could disagree with it (`--no-ama` on a chart with a range band produced a dead band). Nothing in this table sets an indicator on or off; only `--range-span` sizes the band.

| Flag | Description | Default |
|------|-------------|---------|
| `--source <json\|market_adapter>` | Data source type | `json` |
| `--file <path>` | Candle JSON input file (required for `json` source) | — |
| `--bot-key <key>` | Bot key for `market_adapter` source | — |
| `--chart <path>` | Output HTML file | `analysis/charts/tradingview_chart.html` |
| `--title <text>` | Chart title | auto-generated from meta |
| `--price-scale <log\|linear>` | Price-axis scale | `log` |
| `--sma-period <n>` | SMA period | `500` |
| `--ama-er-period <n>` | AMA ER period | `781` |
| `--ama-fast-period <n>` | AMA fast period | `5.2` |
| `--ama-slow-period <n>` | AMA slow period | `83.5` |
| `--vwap-bars <n>` | Rolling VWMA window | `500` |
| `--no-sma` | Disable SMA | — |
| `--no-vwap` | Disable VWMA | — |
| `--no-grid-reset` | Render without the grid-reset simulation (toggle it back in the chart) | on for AMA bots |
| `--grid-delta-pct <n>` | Override the AMA-price Δ threshold for the simulation (skips config resolution) | config |
| `--grid-slope-delta-pct <n>` | Override the AMA-slope Δ threshold for the simulation, in %/bar | config |
| `--grid-warmup <bars>` | Override the simulation start bar (skipped before the first accepted center) | AMA warmup |
| `--range-span <mult>` | x-range around AMA, 1.3–2.1 (default: bot grid setting) | bot grid |
| `--orders-file <path>` | Order-grid JSON override for the overlay (default: `profiles/orders/<botKey>.json`) | bot orders |
| `--no-orders` | Disable the order overlay (levels, reserve/ceiling lines, spread label) | — |
| `--update-marker-ts <sec>` | Draw an "updated from here" line at the given unix timestamp | — |
| `--update-marker-bars <n>` | Bar count shown in the update-marker tag (e.g. `(+12)`) | — |
| `--no-update-marker` | Suppress the update marker even when the candle file has stamped meta | — |
| `--quiet` | Suppress progress logs | — |

## Grid-Reset Simulation

Bot charts (`--bot-key <key>`, i.e. bots with `gridPrice: "ama"`) additionally
replay the market adapter's grid recentering over the candle history, so you can
see *when the grid would have moved* instead of only where it sits today. See
[docs/GRID_RECALCULATION.md](../../docs/GRID_RECALCULATION.md) for the runtime
mechanics; the chart mirrors §3 and §4 and nothing else.

**What it draws**

- **Grid center** (violet step line, legend `Grid`) — the accepted
  `gridCenterPrice`. It only moves on a trigger, so the line is a staircase:
  flat = "the grid would still be sitting here".
- **Simulated range** (violet band) — the grid bounds that center would own:
  the bot's `minPrice`/`maxPrice` multipliers around the accepted center, tilted
  by the *accepted* slope through `applyAsymmetricBounds` +
  `applyNarrowingSideGuard` (the same functions the live grid build uses). It
  re-tilts only at resets, exactly like the real thing.
- **Reset markers** — one vertical line per reset, colored and tagged by reason:
  grey `init` (first accepted AMA snapshot, `market_adapter_bootstrap`),
  amber `Δ1` (`market_adapter_delta_threshold`), cyan `Δs`
  (`market_adapter_ama_slope_delta_threshold`).
- **Panel (bottom-left)** — effective `AMA Δ` and `Slope Δ` thresholds, the
  layer each came from, reset counts, and the last reset.

**Where the thresholds come from**

Resolved through the same chain the running adapter uses, by
`analysis/tradingview/grid_reset_config.ts`:

1. `modules/constants.ts` (`MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT`,
   `AMA_SLOPE_DELTA_THRESHOLD_PERCENT` × `DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT`)
2. `profiles/general.settings.json` → `MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT`
   and `MARKET_ADAPTER.AMA_SLOPE_DELTA_THRESHOLD_PERCENT` (the editor's
   `AMA-Slope Δ`, applied to `amaSlope.deltaThresholdPct` by
   `applyRuntimeDefaultsFromGeneralSettings`)
3. `profiles/market_adapter_settings.json` → `globals` → `pairs[].marketAdapterSettings` → `pairs[].botOverrides[<botName>]`

The effective numbers come from the production resolvers themselves
(`applyRuntimeDefaultsFromGeneralSettings`, `resolveBotCfg`,
`calculateBotThreshold`, `MarketAdapterService.resolveAmaSlopeDeltaThresholdPercent`),
so the chart cannot drift from the runtime. The panel labels the winning layer;
`--grid-delta-pct` / `--grid-slope-delta-pct` short-circuit the chain and report
`cli` as the source.

**Gates the replay honors**

- The `Δs` trigger only fires for AMA-grid bots whitelisted for
  `asymmetricBounds` (range scaling) in
  `profiles/market_adapter_whitelist.json` **and** carrying an explicit
  `weightDistribution` — the adapter skips the slope signal otherwise.
  When gated off, the panel shows the threshold with `off` and the slope
  trigger is inert, like in production. A non-positive resolved threshold
  disables the trigger too (it never means "fire every cycle").
- The replay starts at the AMA warmup point (`getAmaWarmupBars`), capped at half
  the dataset so a short chart still shows something; the applied value is in
  the panel and can be forced with `--grid-warmup`.
- Absolute `minPrice`/`maxPrice` pin the center like `clampGridPriceToBounds` —
  drift is measured against the **clamped** center, so an AMA outside the
  bounds does not emit a reset marker every bar; `"Nx"` multipliers travel with
  the center and never clamp.
- Not simulated (out of scope for a candle chart): RMS structural divergence,
  available-funds resizes, manual/legacy triggers, and the staleness / gap /
  no-new-candle suppression gates. One evaluation per 1h bar.

The replay runs in the page, so the AMA series (and therefore the trigger
points) follows the AMA inputs and preset buttons; the gating parameters that
would come from config (`erPeriod`, lookback, warmup, clip percentile, persistence gate) are fixed
at generation time. One slope window is shared by every consumer: the resolved
`lookbackBars` drives both the replayed `Δs` trigger and the `Scale` band tilt,
so a bot-configured lookback can no longer leave the plotted band measuring a
different slope than the trigger does (the shared constant remains the fallback
for pool/pair charts, which carry no grid-sim data), and both average with the
chart's selected slope model (see Notes). The replay uses the
canonical `simulateGridResetSeries()` from
`analysis/tradingview/grid_reset_sim.ts`, embedded verbatim via
`embedFunctionSources` — not a hand copy of the adapter logic. The page now also resolves the EMA alpha through the same config chain, clamped to the centralized `[2/101, 1]` range the live service uses, and feeds the **canonical `computeAmaSlopeEmaSeries`** into both the replay and the `Scale` band, so the plotted resets and tilt match the slope the live adapter publishes (the clip threshold remains on raw Huber by design).

## Notes

- **Slope averaging.** The AMA slope is a **Huber-robust linear regression of `ln(AMA)` over the lookback window** — `computeHuberWindowSlopePct` in `market_adapter/core/strategies/dynamic_weight_series.ts`, which is the live adapter's own definition and is embedded here verbatim, so the chart and the bot run one logic path. The live adapter (and this chart) then apply a recursive EMA to those per-bar slopes via `computeAmaSlopeEmaSeries` (default alpha `0.2`, `amaSlope.emaAlpha`; `1` = off), adding ~4 bars of lag to flatten sparse-trade spikes. The displayed `Δs` panel prints the applied `ema` value. Its tuning (`C`, `ITERATIONS`, `SCALE_FLOOR`, `ZERO_EPSILON`) is centralized in `MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_HUBER` and injected into the page as `const AMA_SLOPE_HUBER`, so a constant change flows to both. The output is in %/bar over the same window, so the tilt scale (`clamp(slope/maxSlopePct) * maxSlopeOffset`) and the `Δs` gate (`|Δslope| >= 8% of maxSlopePct`) keep their existing units. Measured on the repo's 1h pools with the shipped AMA preset at the shipped 16-bar window: a single-bar AMA impulse is **strongly bounded** (a 1%/3%/5%/10% one-bar spike shifts the two-point endpoint reading by ≈ `spike/lookbackBars` %/bar ≈ 0.06/0.19/0.31/0.63 — 8x to 80x the reset gate — while the robust fit barely moves), and the fit is the smoothest robust option measured (second-difference energy ~25x lower than the old median's). Set `CHART_SLOPE_ESTIMATOR = 'endpoint'` in the page to render the reference two-point definition instead (kept in the core for comparison); the live adapter does not use it. The EMA applies to whichever estimator is selected, so endpoint mode shows the *smoothed* two-point reference.
- The chart embeds the vendored `uPlot` runtime inline (no CDN, no sibling `uplot/` dir, no DEXBot2 install needed). Each export is a single self-contained HTML file that renders anywhere, even after being copied or mailed to a machine without DEXBot2.
- The displayed indicators are computed from the 1h base candles and then sampled onto the selected timeframe.
- The current volume-weighted overlay is a rolling `VWMA`, not a session-reset VWAP.
- SMA is disabled by default.
- VWMA is disabled by default.
- AMA is auto-enabled when the bot has `gridPrice: "ama"` (or ama1-4), otherwise disabled by default.
- The AMA controls start with the bot-specific AMA, then pair-specific entry from `profiles/market_profiles.json` when available, falling back to AMA3 values from `modules/constants.ts`.
- The AMA preset buttons `1–4` select the AMA1–4 defaults (active preset highlighted); numeric inputs remain for fine-tuning.
- The pair switcher inverts the candles client-side, so you can inspect both `A/B` and `B/A` views from one export. The order overlay inverts with it (same levels in display units, side colors preserved).
- The order overlay resolves from `profiles/orders/<botKey>.json` (same files `scripts/analyze-orders.ts` reads): active/partial grid orders only. Pool/pair charts without a bot key render without it, silently. `--no-orders` removes the whole overlay (levels, reserve/ceiling lines, spread label); the in-chart `Orders` checkbox does the same when orders are present. Grid bounds span the full grid, never calculated: the reserve line sits on the lowest grid buy, the ceiling line on the highest grid sell — live (active/partial) and planned (virtual) slots alike; a missing side hides its line instead of drawing an invented level. Bounds render even when no live levels exist yet (levels, spread, and panel BUY/SELL rows need live orders).
- The update marker falls back to `prevUpdateLastCandleSec` / `prevUpdateNewBars` stamped in the candle-file `meta` when the flags are absent; those fields are written by external incremental-fetch tooling, not by anything in this repo.
- `Ctrl+0` (or `Cmd+0`) resets the time-axis zoom to the full dataset.
- Mouse: drag the candles to pan time + price (price drag sets a manual range); wheel zooms time, except over the price axis where it zooms price. Shift+wheel zooms price anywhere over the price pane (cursor-anchored). Dragging the price-axis gutter scales price, dragging the time-axis gutter scales the timeframe; double-click the price axis to return to autofit. While the price range is manual, timeframe moves no longer refit it.
- Indicator, timeframe, scale, and overlay-visibility changes are persisted in browser `localStorage` per pool/pair chart (`dexbot2-tradingview-uplot-v3:<pool>:<A>_<B>:<baseSecs|base>`); cursor sync between the price/volume panes uses a separate constant key. The `Resets` toggle is persisted the same way, so a chart opened from a previous session keeps its simulation state.
- The price axis defaults to log base `10`, with a toolbar switch for `Log` / `Linear`.
- If you regenerate the HTML and then open it later, no CDN access is needed — the `uPlot` library (JS + CSS) is inlined into the file itself, so it renders fully offline and is independent of where the file lives on disk.

## Typical Workflow

1. Pick or generate a candle JSON file.
2. Run `npm run analysis:tradingview` or call the runner directly.
3. Open `analysis/charts/tradingview_chart.html` in a browser.
4. Use the timeframe buttons and indicator controls at the top of the page.

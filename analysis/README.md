# Analysis

Tools that inspect DEXBot trading behavior and the market data it operates on. Output is interactive HTML charts written to `charts/` (regenerated on each run, not committed); none of this runs in production.

## Contents

- [Which tool should I use?](#which-tool-should-i-use)
- [Key Terms](#key-terms)
- [Quick Start](#quick-start)
- [Data Prerequisites](#data-prerequisites)
- [Trade & Portfolio Analysis](#trade--portfolio-analysis)
- [Charts & Visualization](#charts--visualization)
- [Trend & Price Analysis](#trend--price-analysis)
- [Subarea Reference](#subarea-reference)
- [Shared Helpers](#shared-helpers)
- [npm Script Shortcuts](#npm-script-shortcuts)
- [Related Docs](#related-docs)

## Which tool should I use?

| Tool | Ask this when… | One-line command |
|------|----------------|------------------|
| [`trade_profitability.ts`](#trade-profitability-analyzer-trade_profitabilityts) | "Is my bot making money?" — PnL, R-multiples, drawdown | `npm run analysis:trade-pnl -- <account-id>` |
| [`dexbot pnl`](#pnl-html-report-dexbot-pnl) | "Give me a readable PnL report" — self-contained HTML with a lot table | `dexbot pnl <bot\|account> --month 3` |
| [`grid_correction_check.ts`](#last-fill-guard-check-grid_correction_checkts) | "Are fills respecting the direction-only last-fill guard?" | `npm run analysis:grid-check -- --bot-key <bot-key>` |
| [`analyze_risk_profile.ts`](#risk-profile-analyzer-analyze_risk_profilets) | "How wide should my Safe Range clamps be?" | `node dist/analysis/analyze_risk_profile.js --bot-key <bot-key>` |
| [`analyze_trade_heatmap.ts`](#trade-heatmap-analyze_trade_heatmapts) | "Where did trade volume cluster vs the AMA?" | `node dist/analysis/analyze_trade_heatmap.js --bot-key <bot-key>` |
| [`tradingview/analyze_tradingview.ts`](#tradingview-chart-tradingviewanalyze_tradingviewts) | "Just give me a candle chart" | `dexbot tv <bot-key>` |
| [`analyze_dynamic_weight.ts`](#dynamic-weight-research-analyze_dynamic_weightts) | "Are buy/sell weights tuned for this regime?" | `dexbot dw <bot-key>` |
| [`analyze_volatility.ts`](#volatility-analyze_volatilityts) | "Both weights clipped too hard / not enough?" | `node dist/analysis/analyze_volatility.js --bot-key <bot-key>` |
| [`analyze_regime.ts`](#supporting-sub-signals) | "Is the trend/chaos gate too aggressive?" | `node dist/analysis/analyze_regime.js --bot-key <bot-key>` |
| [`analyze_kalman.ts`](#supporting-sub-signals) | "Is Kalman's contribution to the blend right?" | `node dist/analysis/analyze_kalman.js --bot-key <bot-key>` |
| [`ama_fitting/`](#ama-fitting) | "Which AMA preset fits this market?" | `node dist/analysis/ama_fitting/optimizer_high_resolution.js --data <lp-file>` |
| [`bot_fitting/`](#bot-fitting) | "What spread / increment / ratio for my grid?" | `node dist/analysis/bot_fitting/backtest_ama_sweep.js --data <lp-file>` |

> `<account-id>` = a BitShares `1.2.x` account ID or name. `<bot-key>` = a key from `profiles/bots.json`. `<lp-file>` = a JSON file under `market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json`.

## Key Terms

Common abbreviations used throughout: OHLC, AMA, ER, ATR, Kalman, Hurst, PE, R, LIFO, FIFO, PnL, SMA, VWMA. Full definitions below.

<details><summary><mark>Abbreviation glossary (click to expand)</mark></summary>

| Term | Full name | Plain English |
|------|-----------|---------------|
| **OHLC** | Open, High, Low, Close | The four price points that describe each candle (bar) on a chart |
| **AMA** | Adaptive Moving Average | A trend line that speeds up in trending markets and slows down in choppy ones. AMA1–AMA4 are presets with different speeds. |
| **ER** | Efficiency Ratio | How directional price movement was in a period (0 = pure noise, 1 = straight line) |
| **ATR** | Average True Range | How much the price typically moves per bar — a volatility measure |
| **Kalman** | Kalman Filter | A mathematical filter that estimates the true trend by separating signal from noise |
| **Hurst** | Hurst Exponent | A number (0–1) that tells you if the market is trending (>0.5), mean-reverting (<0.5), or random (=0.5) |
| **PE** | Permutation Entropy | How unpredictable the price pattern is — low PE = orderly trend, high PE = chaos |
| **R** | Risk multiple | A trade's return measured in "average losing trade" units. A +3R trade earned 3× what a typical loser costs you. |
| **LIFO** | Last In, First Out | Sell the most recently bought asset first (matches grid-bot cycles) |
| **FIFO** | First In, First Out | Sell the oldest purchased asset first (conservative, reflects holding cost) |
| **PnL** | Profit and Loss | Net earnings from trading |
| **SMA** | Simple Moving Average | Average price over N bars — the basic trend line |
| **VWMA** | Volume-Weighted Moving Average | Like SMA but gives more weight to bars with higher volume |

</details>

## Quick Start

Two entry points, depending on what you're asking:

**"What's my bot doing right now?"** — pass a bot key from `profiles/bots.json`:

```bash
npm run analysis:tradingview -- --source market_adapter --bot-key <bot-key>
node dist/analysis/analyze_dynamic_weight.js --bot-key <bot-key>
```

**"How much money did my bot make?"** — pass a BitShares account ID or name:

```bash
npm run analysis:trade-pnl -- 1.2.123456 --hours 168
```

> The market adapter source reads from `market_adapter/state/market_adapter_centers.json` — run the bot first to populate state.
> Prefer the `npm run analysis:*` shortcuts; they wrap the compiled runners with the same flags (see [npm Script Shortcuts](#npm-script-shortcuts) for the full mapping).

## Data Prerequisites

Most runners expect candle data. Two paths to get it:

**Market adapter source** (default for most runners) — reads from `market_adapter/state/market_adapter_centers.json`. No setup needed; just run the bot first to populate state.

**LP candle files** — for deeper analysis with full OHLC data:

```bash
# Via the market adapter LP exporter (recommended for blockchain-backed candles)
node dist/market_adapter/inputs/fetch_lp_data.js --pool 133 --precA 4 --precB 5 --interval 1h --lookback 26280h

# Via the analysis fetcher (shares the month-shard candle cache with dexbot tv/dw)
node dist/analysis/ama_fitting/fetch_lp_candles.js --pool 1.19.133 \
  --assetA <ASSET_A> --assetAId <asset_a_id> --assetAPrecision <n> \
  --assetB <ASSET_B> --assetBId <asset_b_id> --assetBPrecision <n>
```

Placeholder key:

- `<pair>` — the asset-pair folder name under `market_adapter/data/lp/`.
- `<id>` — LP pool number you fetched with `--pool`.
- `<interval>` — candle interval, e.g. `1h`.
- `<ASSET_A>` / `<ASSET_B>` — asset symbols; `<asset_a_id>` / `<asset_b_id>` their `1.3.x` IDs; `<n>` their on-chain precision.

See [ama_fitting/README.md](ama_fitting/README.md) for full fetch options and data format.

## Trade & Portfolio Analysis

### Risk Profile Analyzer (`analyze_risk_profile.ts`)

Measures inventory risk by calculating empirical divergence quantiles (based on price-to-AMA deviation). Use this to calibrate 'Safe Range' clamping tiers for your liquidity strategy.

```bash
node dist/analysis/analyze_risk_profile.js --bot-key <bot-key>

# From explicit LP candle file
node dist/analysis/analyze_risk_profile.js \
  --file market_adapter/data/lp/<pair>/lp_pool_<id>_1h.json \
  --ama AMA3 \
  --output analysis/charts/risk_report.html
```

Metrics include:
- **Max Divergence:** Structural risk limit of the AMA preset.
- **Quantiles (99.9%, 99.99%, 99.999%):** Safe Range bounds for clamping tiers.
- **σ_ama_delta:** Std dev of per-bar AMA movement — use this to calibrate `AMA_DELTA_THRESHOLD_PERCENT`.

### Trade Profitability Analyzer (`trade_profitability.ts`)

Fetches `fill_order` operations for a BitShares account from Kibana within a specified time range, then computes realized PnL via sequential (LIFO) or FIFO inventory tracking per asset pair.

**Pipeline:** Kibana fill query → on-chain asset precision resolution → buy/sell classification → chronological matching (sequential LIFO by default) → per-pair summary + optional per-match detail, or a self-contained HTML report (`--html`).

**Account resolution:** a bot profile name, an account name, or a bare `1.2.x` ID is resolved through the shared `account_resolver.ts` helper. A local bot profile is checked **first** (no chain call), then a stored `accountId`, then the chain; the resolved ID is stamped onto the matching `profiles/bots.json` entry, so later runs resolve offline. `--refresh-account` forces a fresh lookup.

`dexbot pnl` is the HTML front door (see [`scripts/README.md`](../scripts/README.md)); the raw analyzer below defaults to terminal tables.

```bash
# HTML report for a local bot, last 3 months (dexbot pnl wraps this)
dexbot pnl my-bot --month 3

# HTML report for a raw account, filtered to one pair
dexbot pnl 1.2.123456 --month 6 --pair TOKENA/BTS

# Terminal output: account by ID, last 3 months (default)
node dist/analysis/trade_profitability.js 1.2.123456

# Account by profile/account name (local profiles first)
node dist/analysis/trade_profitability.js "my-account-name" --month 1

# Absolute window with pair filter
node dist/analysis/trade_profitability.js 1.2.123456 \
  --start 2026-07-01 --end 2026-07-07 --pair TOKENA/BTS

# Export trade log and full analysis
node dist/analysis/trade_profitability.js 1.2.123456 \
  --hours 168 --csv trades.csv --json results.json

# Conservative accounting (FIFO)
node dist/analysis/trade_profitability.js 1.2.123456 \
  --hours 168 --match-mode fifo
```

<details><summary><mark>Options (click to expand)</mark></summary>

| Flag | Default | Description |
|------|---------|-------------|
| `--month <n>` | `3` | Lookback months (730 h each; alias `--months`) |
| `--start <iso>` | — | Start time (ISO 8601) |
| `--end <iso>` | — | End time |
| `--hours <n>` | — | Lookback hours (alternative to month/start/end) |
| `--pair <BASE/QUOTE>` | all | Filter to one pair by symbol or `1.3.x` id |
| `--asset <id>` | all | Filter to one base asset ID |
| `--refresh-account` | off | Force re-resolution and bypass the fills cache (re-query the range) |
| `--html` | off | Write a self-contained HTML report instead of terminal tables |
| `--report <file>` | auto | Override the report path (implies `--html`) |
| `--csv <file>` | — | Export chronologically sorted trade list |
| `--json <file>` | — | Export full analysis with per-pair PnL data |
| `--match-mode <mode>` | `sequential` | Matching mode: `sequential` (LIFO, default) or `fifo` |
| `--trades` | off | Show per-order PnL detail (terminal mode only) |
| `--fee-per-order <bts>` | `0.09652` | Blockchain fee per limit_order_create op (BTS); approximate |
| `--verbose` | off | Print per-pair trade counts during processing |

</details>

**Fill cache:** per-account `fill_order` fetches are cached in calendar-month shards under `<analysis>/cache/fills/<accountId>.shard_YYYY-MM.json` (see `fills_cache.ts`). A settled month is answered from disk with zero queries; only the still-unsettled tail (the last ~6 h before the previous query, where Kibana may still index late fills) is re-queried. `--refresh-account` ignores coverage and re-queries the requested range (merging, so it never drops fills outside that span). Delete the shard files to reset the cache.

**Asset precision handling:**

1. Assets listed in the static `ASSETS` table (BTS, TWENTIX, XBTSX.*, HONEST.*, IOB.*, etc.) resolve instantly.
2. Unknown assets are resolved on-chain via `get_assets` against the built-in node pool, with results cached at runtime.
3. If resolution fails or an asset is not found on chain, the affected fills are **skipped** with a warning (no abort). Symbols learned on-chain are cached too, so `--pair SYMBOL/QUOTE` works even for assets absent from the static table.

**PnL methodology:**

- **Ordering:** Trades within each pair are sorted chronologically (block number + operation index).
- **Lot tracking:** Buys add lots to an inventory queue.
- **LIFO (default):** Sells consume the newest lots first — matching the actual grid cycle where a buy at one level is sold at the next tick up.
- **FIFO:** Sells consume the oldest lots first, reflecting the real cost of carrying inventory through a trend.
- **Per-match PnL:** `(sellPrice − buyPrice) × matchedAmount`, reported in quote-asset units and as a percentage of the buy price.
- **Summary PnL%:** Uses volume-weighted average prices from matched lots only.
- **Unmatched sells:** Sells without a preceding buy in the window are surfaced in the pair summary.
- **Maker/taker flags:** The per-match detail table includes these for both the entry (buy) and exit (sell) legs, sourced from the blockchain operation.
- **Cross pairs:** For non-BTS pairs, assets are normalised by ordering the lower asset ID as base so buy/sell direction is consistent. PnL is reported in the pair's quote asset — a warning is shown when non-BTS quotes are present.
- **Programmatic use:** The script exports `analyzePair`, `classifyFills`, `computeMetrics`, and their TypeScript types.

**Metrics glossary** — `R` = the size of the average losing trade. A +3R trade earned 3× what a typical loser costs you.

<details><summary><mark>Per-metric definitions (click to expand)</mark></summary>

| Output line | Meaning |
|-------------|---------|
| `Win Rate` | % of trades that made money. Higher is better, but above 90% with small wins can hide tail risk. |
| `Profit Factor` | Total BTS won ÷ total BTS lost. Above 1.0 means you're profitable; above 2.0 is strong. |
| `Fee Drag` | % of gross profit eaten by blockchain order-creation fees. Lower = more efficient. |
| `Avg Win / Avg Loss` | Ratio of average winner size to average loser size. Above 1.0 means winners are bigger. |
| `Expectancy (gross)` | How much one trade is expected to earn before fees. Positive = edge exists. The `R` version normalises this by the average loss size (reports in R-multiples instead of BTS). The `net` version subtracts fees. |
| `Median R` | The middle R-multiple value (half of trades are above, half below). `>1R` / `>2R` = % of trades that earned more than 1× or 2× the average loss. `<-1R` = % that lost more than 1× the average loss. |
| `PnL distribution` | Median, P25, P75, Best, Worst — the centre, spread, and extremes of per-trade return %. Not annualised, just per cycle. |
| `Sharpe (ann)` | The window's net PnL per unit of volatility, annualised (`mean/std × √periods-per-year`). Binned daily for ≥ 3-day windows, hourly below; every period counts, flat ones as 0 PnL. Shown as `value ± estimation error [bin, n, confidence]` — short windows are low confidence, and only same-bin runs are comparable. Dimensionful (absolute PnL, not % returns). |
| `Sortino (ann)` | As Sharpe, but only losing periods feed the downside deviation. `∞` means the window had no losing periods. |
| `Projected net PnL` | Scored-window net PnL scaled linearly to a year (`÷ scored days × 365`) — same whole-period basis as Sharpe/Sortino, so a trailing partial period is excluded from both. A projection, not a forecast. |
| `Max Drawdown` | Largest peak-to-trough decline of the realised-PnL curve, in quote units (with the same decline as a % of peak cumulative profit). Realised only — open inventory isn't marked. |
| `Max Recovery Time` | Longest time (in days) from the deepest point of a drawdown back to a new equity high. |
| `Max Consecutive W/L` | Longest streak of winning or losing round-trips. Grouped by sell order, so one order covering multiple buy lots counts as one result. Grid bots naturally cluster wins during trends — streaks of 100-200 are not alarming. |
| `Avg hold time` | Average time (hours) between buying an asset and selling it. |
| `Maker / Taker` | % of trade legs (buys + sells combined) where the bot provided liquidity (maker, resting on the book) vs took it (taker). Higher maker % = lower fees. |
| `Sell orders filled` | Number of distinct sell orders that were filled in the period. |
| `Partial fills/order` | How many buy lots each sell order consumed (mean, median, max). For a grid bot: 2.0 median means half the orders clear 2 grid levels; 18 max means one big sweep. |
| `One-shot orders` | % of orders that matched exactly 1 buy lot. Low % = your grid is thick enough that orders routinely cover multiple levels. |
| `Fills/day` | Average matched lots per scored day, on the same whole-period basis as the ratios above. Raw activity speed. |
| `Avg vol/day` | Average daily trading volume in the quote asset over that same scored window. |

</details>

### PnL HTML Report (`dexbot pnl`)

`dexbot pnl` is the HTML front door: it resolves the account, fetches fills (through the fill cache), computes the same realized-lot PnL as the terminal analyzer, and renders a single self-contained HTML file via `analysis/pnl_report.ts`. No network, CDN, or sibling assets — it opens from a `file://` link anywhere. The file lands under the analysis `charts/` directory (or the path given to `--report`).

```bash
# Local bot profile, last 3 months
dexbot pnl my-bot

# Raw account, one pair, generated path printed on exit
dexbot pnl 1.2.123456 --month 6 --pair TOKENA/BTS
```

Per pair the report shows:

- **Hero** — account (bot name + `1.2.x` id), period, pair/lot counts, match mode, active filters.
- **Card blocks (2x2 left + 2x2 right)** — left = money (Gross PnL, Net PnL, Volume, Fees); right = position/activity (Realized lots, Net inventory Δ, Avg buy/sell, Unmatched sold). When both market and blockchain fees exist they collapse into one `Fees` card so the block stays 2x2.
- **Metrics grid** — Edge, Risk, Distribution, Behavior & activity: the same metric set as the terminal output (see the metrics glossary above).
- **Realized lots table** — collapsible per-match detail (entry/exit time, prices, gross/net PnL, fees, maker/taker legs), capped at 2,000 rows — use `--csv` for the full list.

All amounts use the shared 4-significant-figure formatter (compact `K`/`M`, significant trailing zeros kept) — the same one `dexbot order` uses. `--refresh-account` re-resolves the account and bypasses the fill cache (see [Fill cache](#trade-profitability-analyzer-trade_profitabilityts)).

### LAST-FILL-GUARD Check (`grid_correction_check.ts`)

Validates LAST-FILL-GUARD discipline from the same Kibana fill pipeline as `trade_profitability.ts`. The rule is **direction only** (v1.6.16+): with the previous fill at price `p`, the next order must satisfy `BUY < p` and `SELL > p` (equal price is blocked — a re-place at the just-filled level). There is no increment band: the older `pivot ± i/2` rule blocked a BUY below a SELL fill and a SELL one tick above our cost, i.e. it flagged the tightening placements the engine legitimately makes. A violation is a buy fill at/above its pivot or a sell fill at/below it.

**Offline limits:** the tool reconstructs pivots from consecutive fills, so it cannot see the runtime's edge-pinned-fill exclusion (no slot identity per fill) nor the spread-correction bypass — expect rare false positives on wick/insurance fills.

**Pipeline:** Kibana `fill_order` query (paginated `search_after`) → on-chain asset precision resolution → buy/sell classification → chronological sort → per-order/price-epoch aggregation (partial fills at one price collapsed to weighted-average; repriced order lifetimes kept separate) → consecutive direction comparison → violation report with daily histogram.

```bash
# Per-order aggregated check (default), last 7 days
npm run analysis:grid-check -- --bot-key <bot-key> --hours 168

# 30 days, JSON + CSV export of violations
npm run analysis:grid-check -- --bot-key <bot-key> --hours 720 --json out.json --csv out.csv

# Raw fill granularity instead of per-order aggregation
npm run analysis:grid-check -- --bot-key <bot-key> --per-fill --hours 168

# Override the bot's configured grid increment (informational: the guard has no band)
npm run analysis:grid-check -- --bot-key <bot-key> --hours 168 --increment 0.5
```

Exit code `0` = pass, `2` = violations found, `1` = fatal error. Bot keys resolve via `profiles/bots.json` (`--list-bots` to enumerate); the account defaults to the bot's stored `accountId` when present (no chain lookup — the ID is auto-saved next to `preferredAccount` after the first successful name resolution, re-verified with `--refresh-account`), otherwise `preferredAccount` is resolved on-chain, and can be overridden with `--account <1.2.x|name>`.

<details><summary><mark>Options (click to expand)</mark></summary>

| Flag | Default | Description |
|------|---------|-------------|
| `--bot-key <key>` | — | Bot key or name from `profiles/bots.json` (required) |
| `--hours <n>` | `168` | Lookback hours from now |
| `--start <iso>` / `--end <iso>` | — | Absolute time window |
| `--account <id>` | bot `preferredAccount` | Override account ID or name |
| `--refresh-account` | off | Force re-resolution of `preferredAccount` and update the stored `accountId` when it changed |
| `--increment <pct>` | bot config / `0.5` | Grid increment used to derive the half-increment guard band |
| `--per-fill` | off | Check at fill granularity instead of per-order aggregated |
| `--include-cross-pair` | off | Also check consecutive fills across different pairs |
| `--tolerance <pct>` | — | Deprecated compatibility alias for `--increment`; its value is doubled and a warning is emitted |
| `--json <file>` / `--csv <file>` | — | Export violations |
| `--verbose` | off | Print the fetched trade sequence before checking |
| `--list-bots` | — | List available bot keys and exit |

</details>

**Notes:** this is an offline approximation of decision-time placement. Batch-placed orders can share an earlier pivot, and the tool does not model the runtime spread-correction bypass. In the default mode, partial fills at one price are collapsed to a weighted average while fills from separate native order repricing epochs remain independent.

## Charts & Visualization

### Trade Heatmap (`analyze_trade_heatmap.ts`)

Generates a 2D heatmap + summed histogram showing where trade volume concentrates relative to AMA deviation. Time-slice rows show how the distribution evolved; the bottom histogram shows the aggregate bell-curve shape with threshold annotations.

```bash
node dist/analysis/analyze_trade_heatmap.js --bot-key <bot-key>

# From explicit LP candle file
node dist/analysis/analyze_trade_heatmap.js \
  --file market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json \
  --ama AMA3 \
  --output analysis/charts/trade_heatmap.html \
  --bin-size 5 \
  --max-neg 50 \
  --max-pos 60 \
  --slice-months 6
```

<details><summary><mark>Options (click to expand)</mark></summary>

| Flag | Default | Description |
|------|---------|-------------|
| `--source` | `market_adapter` | Data source: `market_adapter` or `json` |
| `--bot-key` | — | Bot key from `profiles/bots.json` (required for `market_adapter` source) |
| `--file` | — | Path to LP candle JSON (for `json` source) |
| `--ama` | `AMA3` | AMA preset (AMA1–AMA4) |
| `--output` | `analysis/charts/trade_heatmap.html` | Output path |
| `--bin-size` | `5` | Percentage points per bin |
| `--max-neg` | `bin-size × 10` | Max negative deviation % |
| `--max-pos` | `bin-size × 10` | Max positive deviation % |
| `--buckets` | — | Total bins (symmetric, overrides `--max-neg/--max-pos`) |
| `--warmup` | AMA erPeriod | Bars to skip for AMA warmup |
| `--slice-months` | `12` | Months per time-slice row |
| `--thresholds` | `1,2,3,5,10,20` | Deviation % thresholds for volume concentration table |
| `--list-bots` | off | List available bot keys and exit |
| `--quiet` | off | Suppress log output |

</details>

### TradingView Chart (`tradingview/analyze_tradingview.ts`)

Generates a standalone TradingView-style HTML chart with candle OHLC, SMA, AMA, VWMA, and volume panel. For AMA-grid bots it also replays the market adapter's grid resets (AMA-price Δ / AMA-slope Δ) using the thresholds resolved from `general.settings` / `market_adapter_settings` — see [tradingview/README.md](tradingview/README.md#grid-reset-simulation) and [docs/GRID_RECALCULATION.md](../docs/GRID_RECALCULATION.md). Indicator state is set in the chart toolbar, not on the command line (`SMA`, `AMA`, `VWMA`, `Range`, `Scale` checkboxes; `Range` / `Scale` opt into the AMA they are derived from), and the toolbar choice is remembered per chart in the browser. See [tradingview/README.md](tradingview/README.md) for full documentation.

# Recommended one-step: bot, pool, or pair (fetches candles + renders, default 3 months)
dexbot tv <bot-key>
dexbot tv 133
dexbot tv TOKENA/TOKENB
dexbot tv BTS/HONEST.USD --feed  # opt-in: MPA price-feed history instead of market candles
# Manual: bot-key (auto-resolves candle file and AMA settings)
npm run analysis:tradingview -- --source market_adapter --bot-key <bot-key>

# From an explicit candle file
node dist/analysis/tradingview/analyze_tradingview.js \
  --file market_adapter/data/market_adapter_<bot-key>_1h.json \
  --chart analysis/charts/<pair>_tradingview.html
```

## Trend & Price Analysis

Two weight-tuning paths feed into the market adapter:

- **Asymmetric** — AMA slope + Kalman, gated by Hurst/PE regime. Shifts buy/sell weight bias.
- **Symmetric** — ATR volatility penalty. Reduces both weights equally in volatile markets.

### Dynamic Weight Research (`analyze_dynamic_weight.ts`)

Interactive 4-panel chart for the asymmetric path: AMA slope plus Kalman confirmation, gated by Hurst Exponent and Permutation Entropy. Use this when tuning buy/sell weight bias, AMA slope offset behavior, and regime damping.

```bash
# Recommended one-step (advanced): bot, pool, or pair — fetches candles and renders,
# same pipeline as `dexbot tv`, default 3 months
dexbot dw <bot-key>
dexbot dw 133 --month 6
dexbot dw TOKENA/TOKENB --month 1

# Direct analyzer (own candle files, research knobs --alpha/--gain/--dw/--lb/--clip)
node dist/analysis/analyze_dynamic_weight.js --bot-key <bot-key>

# From LP candle file with custom parameters
node dist/analysis/analyze_dynamic_weight.js \
  --file market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json \
  --alpha 0.6 --gain 0.25 --clip 20
```

Full research docs: [DYNAMIC_WEIGHT_RESEARCH.md](trend_detection/DYNAMIC_WEIGHT_RESEARCH.md)

### Volatility (`analyze_volatility.ts`)

ATR-based symmetric volatility penalty. Use when both buy and sell weights are being reduced too much or too little.

```bash
node dist/analysis/analyze_volatility.js --bot-key <bot-key>
```

### Supporting sub-signals

The asymmetric path depends on three more filters; each ships as a standalone analyzer so you can diagnose the combined chart's sub-signals in isolation.

| Analyzer | Focus | Use when |
|----------|-------|----------|
| `analyze_regime.ts` | Hurst + PE regime classification | Trend signals need more or less regime damping |
| `analyze_regime_windows.ts` | Alternate Hurst / PE window configs | Regime gate is too slow or too noisy |
| `analyze_kalman.ts` | Kalman velocity / displacement | Isolating the Kalman side of the AMA / Kalman blend |

```bash
node dist/analysis/analyze_regime.js --bot-key <bot-key>
node dist/analysis/analyze_regime_windows.js --bot-key <bot-key>
node dist/analysis/analyze_kalman.js --bot-key <bot-key>

# All also accept explicit LP candle files
node dist/analysis/analyze_volatility.js \
  --file market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json
node dist/analysis/analyze_regime.js \
  --file market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json
node dist/analysis/analyze_kalman.js \
  --file market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json
```

## Subarea Reference

### `trend_detection/`

Shared analyzers and chart renderers for the dynamic-weight signal path. Core engines: Kalman filter, Hurst Exponent, Permutation Entropy, ATR volatility.

**Research docs:**
- [README.md](trend_detection/README.md) — directory overview and module index
- [DYNAMIC_WEIGHT_RESEARCH.md](trend_detection/DYNAMIC_WEIGHT_RESEARCH.md) — AMA+Kalman blend with Hurst/PE regime gating, formula reference, knob guide

<details><summary><mark>Modules (click to expand)</mark></summary>

| Module | Purpose |
|--------|---------|
| `dynamic_weight_chart_generator.ts` | 4-panel uPlot chart with interactive knobs for dynamic weight tuning |
| `kalman_trend_analyzer.ts` | Re-export shim → `market_adapter/core/signals/kalman_trend_analyzer.ts` |
| `kalman_velocity_smoothing.ts` | Re-export shim → `market_adapter/core/signals/kalman_velocity_smoothing.ts` |
| `kalman_chart_generator.ts` | Kalman signal chart generator |
| `hurst_analyzer.ts` | Re-export shim → `market_adapter/core/signals/hurst_analyzer.ts` |
| `permutation_entropy_analyzer.ts` | Re-export shim → `market_adapter/core/signals/permutation_entropy_analyzer.ts` |
| `volatility_chart_generator.ts` | ATR volatility / symmetric shift chart generator |
| `regime_chart_generator.ts` | Regime classification chart generator |

</details>

The four signal analyzers are canonical in `market_adapter/core/signals/`; the
files here are thin re-export shims so analysis tooling keeps a local import
path.

**Note:** `trend_detection/` has no external dependencies — runs directly from the compiled build (`node dist/...`).

### `ama_fitting/`

AMA parameter optimization and comparison tools.

| Script | Purpose |
|--------|---------|
| `optimizer_high_resolution.ts` | AMA parameter optimizer (erPeriod, fast/slow bounds) |
| `generate_unified_comparison_chart.ts` | AMA comparison chart (defaults from constants, use optimizer for fitted params) |
| `analyze_ama_price_changes.ts` | AMA price-change analysis |
| `fetch_lp_candles.ts` | LP candle data fetcher |
| `calibrate_convergence_er.ts` | Calibrate AMA_CONVERGENCE_ER_AVG from LP data |

The AMA implementation itself lives at `market_adapter/core/strategies/ama.ts`.

**Calibration workflow (ER convergence):**

`calibrate_convergence_er.ts` computes the Efficiency Ratio that reproduces the real average smoothing constant (SC) from LP candle data.

Averaging ER first and then applying the SC formula gives a smaller number than applying the formula bar-by-bar and averaging — so the simple mean ER undersells true convergence speed. The tool computes the value the right way.

The current fetched 3-year pool 133 1h dataset calibrates `AMA_CONVERGENCE_ER_AVG` to `0.151`.

```bash
# Default data file (pool 133 1h)
node dist/analysis/ama_fitting/calibrate_convergence_er.js

# Custom data, specific AMAs
node dist/analysis/ama_fitting/calibrate_convergence_er.js \
  --data market_adapter/data/lp/<path>/<file>.json \
  --amas AMA1,AMA3
```

**Note:** `ama_fitting/` has no external dependencies — runs directly from the compiled build (`node dist/...`).

### `bot_fitting/`

Parameter sweep backtests that simulate grid fills for the AMA winners from `ama_fitting/`. Optimizes spread, increment, and max/min ratio for each AMA strategy.

| Script | Purpose |
|--------|---------|
| `backtest_bot_fitting.ts` | Lightweight sweep across spread / increment / ratio with basic risk scoring |
| `backtest_ama_sweep.ts` | Persistent grid simulation with fixed-chain-price mechanics, reposition thresholds, and worker-thread parallelization |
| `shared_utils.ts` | Candle normalization and shared backtest utilities |

```bash
node dist/analysis/bot_fitting/backtest_bot_fitting.js \
  --data market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json
```

```bash
node dist/analysis/bot_fitting/backtest_ama_sweep.js \
  --data market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json \
  --spread 4:16:1 --increment 0.5:4:0.25
```

Details: [bot_fitting/README.md](bot_fitting/README.md)

### `bot_usage/`

| Script | Purpose |
|--------|---------|
| `discover_bot_accounts.ts` | Discover DEXBot accounts on-chain |
| `kibana_bot_queries.ts` | Kibana query helpers for bot activity |

## Shared Helpers

| File | Purpose |
|------|---------|
| `resolve_source.ts` | Shared source resolution: bot-key → candle file, AMA config, `--list-bots` |
| `price_sources.ts` | Unified candle source abstraction (`json`, `market_adapter`) |
| `chart_utils.ts` | Shared chart rendering utilities |
| `chart_css.ts` | Shared uPlot CSS fragments for generated charts |
| `chart_ui.ts` | Shared browser-side uPlot helpers (cursor, hover, zoom-reset, sizing) |
| `math_utils.ts` | Shared math utilities |
| `bot_key_utils.ts` | Bot-key resolution, candle file lookup, `accountId` persistence (`persistBotAccountId`) |
| `account_resolver.ts` | Account resolution for all tools: `preferredAccount` / `--account` → `1.2.x`, stamping the result into `profiles/bots.json` |
| `chain_pool.ts` | Ephemeral read-only chain client over the built-in node pool (account + asset lookups) |
| `fills_source.ts` | Shared `fill_order` Kibana fetch/query and the static asset-precision table + on-chain cache |
| `fills_cache.ts` | Per-account month-shard cache for `fill_order` fetches (settled months reused, unsettled tail refreshed); month-shard naming comes from `market_adapter/utils/month_shards.ts` |
| `pnl_report.ts` | Self-contained HTML PnL renderer: hero, card blocks, metrics grid, realized-lots table |

On-chain account and asset lookups in the fill-based tools go through `account_resolver.ts` / `fills_source.ts` (both built on `chain_pool.ts`): tool scripts must not open their own read-only clients or carry their own node list. The batch backfill `resolve_bot_accounts.ts` is the exception — it reuses the production chain client over one connection.

## npm Script Shortcuts

These npm scripts wrap common analysis runners:

| Script | Command |
|--------|---------|
| `npm run analysis:tradingview` | `node dist/analysis/tradingview/analyze_tradingview.js` |
| `npm run analysis:trade-pnl` | `node dist/analysis/trade_profitability.js` |
| `npm run analysis:grid-check` | `node dist/analysis/grid_correction_check.js` |
| `npm run ama:chart:lp-local` | `node dist/analysis/ama_fitting/generate_unified_comparison_chart.js` (chart also auto-generated by optimizer) |

All accept `--` forwarded flags.

```bash
# Bot-key shortcuts
npm run analysis:tradingview -- --source market_adapter --bot-key <bot-key>

# Trade PnL
npm run analysis:trade-pnl -- 1.2.123456 --hours 720

# LAST-FILL-GUARD check
npm run analysis:grid-check -- --bot-key <bot-key> --hours 168

# File-based
npm run analysis:tradingview -- --file market_adapter/data/market_adapter_<bot-key>_1h.json
npm run ama:chart:lp-local -- --data market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json
```

## Related Docs

- [Market Adapter](../market_adapter/README.md) — live AMA pricing, grid triggers, dynamic weights, and recalc triggers
- [Order Engine Retrospective](../docs/ORDER_ENGINE_POST_1.0_RETROSPECTIVE.md) — orphan/gap-band root-cause plans; `grid_correction_check` is their regression gate
- [DEXBot2 Tuning Cheat Sheet](../claw/docs/DEXBOT2_TUNING_CHEAT_SHEET.md) — grid tuning reference for live bots
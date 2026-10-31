## Bot Fitting Backtest

This folder contains parameter sweep backtests that simulate grid fills for the four AMA winners produced by the optimizer in `analysis/ama_fitting/` (results land in `analysis/results/`).

### What it optimizes

For each of the 4 AMA strategies, it searches for best:

- `spread` (% target spread for the gapSlots spread zone)
- `increment` (% geometric rail step)
- `max/min ratio` (symmetric range around AMA, e.g. `2.0` means `[AMA/2, AMA*2]`)

### Scripts

- `backtest_bot_fitting.ts` — lightweight sweep across spread / increment / ratio with unit-size percentage-point accounting and risk scoring
- `backtest_ama_sweep.ts` — persistent grid simulation with capital-weighted sizing, weight profiles, and worker-thread parallelization
- `backtest_lookback_drawdown.ts` — paired Huber-lookback comparison of
  drawdown / net capture / reset churn (geometry fixed); see
  `docs/AMA_SLOPE_WINDOW.md`
- `shared_utils.ts` — shared helpers (argument parsing, data loading, formatting)

Both simulators share the same production grid model (ported once in
`backtest_bot_fitting.ts` and imported by the sweep), so identical params
build byte-identical grids in both tools.

### Production alignment

Both simulators port the live bot lifecycle end to end:

- **Grid geometry** — `createOrderGrid` (modules/order/grid.ts): master rail at
  `√(1±inc)` offsets bounded by `[center/ratio, center×ratio]` with a
  `calculateGapSlots` spread zone centered on the placement price; order prices
  are placement-time constants.
- **Slot rotation (anchor-&-refill)** — a filled buy at rail node `k` instantly
  re-offers its base at the adjacent master-rail node `k+1`; when that refill
  sells, exactly one rail hop minus the round-trip fee is booked and the freed
  quote re-bids node `k−1`. A slot keeps cycling on small oscillations between
  resets — this is what a refilled live slot earns, not a cross-gap
  differential. Re-armed orders carry a one-bar replacement-lag cooldown.
  Sub-note: because rails chain by `×(1+inc)` above center and `×(1−inc)`
  below, a down-chain hop equals `inc/(1−inc)` (e.g. 1.0101% at inc=1%), not
  exactly `inc` — matching real rail adjacency.
- **Inventory-funded selling** — unlinked (initial-grid) sells execute only
  against held base, priced against the weighted-average entry of the position;
  unfundable sells stay open and retry (never shorting).
- **Inventory carry** — resets cancel ALL live orders (initial leftovers plus
  armed refills/rebids); bought-and-held base merges into a weighted-average-
  entry pool that survives resets (production resync never market-sells). The
  end-of-run inventory mark is reported as an INFORMATIONAL field — it is real
  carried risk but excluded from scoring/ranking.
- **Reset triggers** (MARKET_ADAPTER):
  - Trigger A: AMA drift ≥ `AMA_DELTA_THRESHOLD_PERCENT` (1%) from the recorded
    center, ratchet semantics — always on.
  - Trigger B: slope-delta reset (`|slope − baseline| ≥
    AMA_SLOPE_DELTA_THRESHOLD_PERCENT/100 × DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT`
    over the `DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS` average-slope series, baseline
    re-seeded every reset) plus the slope-ratio grid price offset
    (`direction × min(|slope|/maxSlopePct,1) × targetSpread/2`, applied to the
    placement center). Both are gated behind `--asymmetric-bounds`, mirroring
    the production per-bot asymmetricBounds whitelist — default OFF for a
    typical non-whitelisted bot.
- **BTS operation fees** — every order placement (initial grid + armed
  refills + rebids) pays a maker create fee, every reset cancel pays a cancel
  fee; totals are deducted from net capture (bot_fitting converts against
  `--bts-fee-capital`, the sweep converts via `--tx-fee-price` in capital units).

Documented remaining deltas (inherent to OHLC research sims): bar-granularity
triggers, all-or-nothing fills on raw hi/lo touch, unit/capital sizing instead
of live balance + dynamic-weight sizing, pool-price fills without
microstructure, and no consolidation/dust-cancel/COW/collision mechanics.

### Input dependencies

Both scripts require:

- **LP candles JSON** (recommended 1h), from `market_adapter/data/lp/` — pass via `--data`
- **AMA optimization winners JSON**, from `analysis/results/` — for `backtest_ama_sweep.ts`, pass via `--results`

### Run

```bash
# Lightweight sweep
node dist/analysis/bot_fitting/backtest_bot_fitting.js \
  --data <path-to-lp-candles.json>

# Persistent grid simulation with AMA winners
node dist/analysis/bot_fitting/backtest_ama_sweep.js \
  --data <path-to-lp-candles.json> \
  --results <path-to-optimization-results.json>

# Paired lookback drawdown comparison (no --results needed)
node dist/analysis/bot_fitting/backtest_lookback_drawdown.js \
  --data market_adapter/data/lp/<market-pair> \
  --lookbacks 12,14,16,20
```

> `backtest_ama_sweep.ts` accepts `--lookback <bars>` to override the slope
> window (`DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS`); `backtest_lookback_drawdown.ts`
> builds on it and reports the paired per-lookback deltas.

> `backtest_bot_fitting.ts` auto-derives `--results` from the `--data` filename
> (`analysis/results/optimization_results_<base>_w<λ1>_<λ2>_<λ3>_<λ4>.json`,
> newest `_w*` file matching the base name; falls back to the legacy
> `optimization_results_<base>.json`) when omitted.
> `backtest_ama_sweep.ts` requires `--results` explicitly.

Optional tuning (values shown are examples, not defaults):

```bash
node dist/analysis/bot_fitting/backtest_bot_fitting.js \
  --data <path-to-lp-candles.json> \
  --spread 0.4:1.6:0.1 \
  --increment 0.2:0.8:0.1 \
  --ratio 1.5,2,2.5,3,4,5,8,10 \
  --active-orders 5 \
  --fee 0.20 \
  --min-spread-factor 2.1 \
  --asymmetric-bounds \
  --risk-duration 1.0 \
  --risk-peak-open 2.0 \
  --risk-imbalance 1.2 \
  --risk-cancel 0.15
```

> Default `--ratio` is `1.5,1.75,2,2.5,3,4,5,8,10` (includes `1.75`).
> Default `--active-orders` sizes EVERY rail slot in bounds (production
> behavior); pass a number to cap the search to the slots nearest the gap.

### Output

Results are written to `analysis/results/` (filenames derived from the input
data file: `bot_fitting_results_<base>.json` and `ama_sweep_results_<base>.json`).

The console also prints best parameter set per AMA with matched pairs (cycles),
fill efficiency, net capture and score.

### Notes

- This is an offline simulation proxy, not a full chain execution model.
- Hop granularity: the sim arms each refill at the ADJACENT master-rail node
  (one increment). Production derives leg spacing from the gap-aware
  boundary crawl (`deriveTargetBoundary`: one slot per non-partial fill,
  burst-capped), so for wide-gap configs live legs may span `gapSlots` rail
  steps (~targetSpread) instead of one. Calibrate against real bot fills
  before trusting absolute magnitudes; rankings remain internally consistent.
- `--min-spread-factor 2.1` enforces `spread >= 2.1 x increment`
  (`GRID_LIMITS.MIN_SPREAD_FACTOR`), matching `calculateGapSlots`.
- Score used for ranking (bot_fitting):
  - `totalNetCaptureAfterFeesPct` = realized per-rotation gross (one rail hop
    or weighted-average-entry sale) − round-trip fee − BTS op fees; the
    end-of-run inventory mark is NOT included
  - `baseScore = totalNetCaptureAfterFeesPct * (fillEfficiency / 100)`
  - `riskPenalty = avgOpenDurationBars*1.0 + peakOpenOrders*2.0 + avgImbalance*1.2 + canceledOnReposition*0.15`
  - `finalScore = baseScore - riskPenalty`
- Score used for ranking (sweep): realized profit only —
  - `netProfitPerCapital * 100 * log10(max(1, matchedPairs)) - maxDrawdownPct * 0.5`
    (`maxDrawdown` tracks REALIZED equity swings; carried-bag risk stays
    visible through `finalInventoryUnits` / `finalInventoryMarkUnits`)

## Persistent Grid Simulation Details

`backtest_ama_sweep.ts` models the real bot mechanics:

- Orders sit at FIXED chain prices until canceled or filled
- Slot rotation: a filled buy re-offers the adjacent rail node above; its fill
  books one rail hop net of fees and re-bids the node below (anchor-&-refill)
- Unlinked sells execute only against held inventory at weighted-average entry;
  bought-and-held base carries across resets and is marked to close
  informationally (excluded from profit; drawdown also tracks realized equity
  only — bag risk stays visible through the info fields)
- When triggers fire (A drift, B slope under `--asymmetric-bounds`), the grid
  re-centers and all live orders cancel
- Order sizing depends on capital, ratio (range width), and weight profile
- Three weight profiles: valley, neutral, mountain (symmetric buy/sell)

Search grid defaults — centered around bot defaults (spread=2%, increment=0.5%):

| Param | Default Range |
|-------|--------------|
| Spread | 0.5:4:0.25 + 5:12:1 (%) |
| Increment | 0.2:2:0.1 + 2.5:8:0.5 (%) |
| Max/min ratio | 1.05, 1.1, 1.15, 1.2, 1.3, 1.5, 2, 3, 5, 10 |
| Reposition threshold | 1% (production `AMA_DELTA_THRESHOLD_PERCENT`) |
| Max orders per side | 20 (size cap) |
| Round-trip fee | 0.20% |
| Spread ≥ factor × increment | 2.1 |

All parameters above are tunable via CLI flags. Additional tuning flags:

| Flag | Default | Description |
|------|---------|-------------|
| `--capital <n>` | 10000 | Notional capital per side |
| `--reposition <pct>` | 1 | AMA drift % to trigger re-center |
| `--asymmetric-bounds` | off | Enable slope-delta reset (B) + grid price offset |
| `--bts-create-fee <n>` | 0.48260 | BTS create order fee |
| `--bts-cancel-fee <n>` | 0.00482 | BTS cancel order fee |
| `--maker-create-factor <n>` | 0.10 | Maker share of create fee |
| `--tx-fee-price <n>` | 1.0 | Convert BTS fees into backtest units |
| `--top <n>` | 15 | Top N results displayed per AMA |
| `--help` | — | Print full usage |

The sweep parallelizes across AMAs using worker threads (one per AMA strategy).
Use `--help` for the complete option list.

```bash
node dist/analysis/bot_fitting/backtest_ama_sweep.js \
  --data <path-to-lp-candles.json> \
  --results <path-to-optimization-results.json> \
  --spread 4:16:1 --increment 0.5:4:0.25
```

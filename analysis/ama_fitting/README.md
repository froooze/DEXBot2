# AMA Fitting

Tooling to fit AMA parameters (ER, Fast, Slow) against real LP pool candle data.
The optimizer writes result JSON by default and can explicitly export the chosen
parameters into `profiles/market_profiles.json` for the market adapter.

---

## Workflow Overview

```
1. fetch_lp_candles.ts   →   market_adapter/data/lp/<pairFolder>/lp_pool_<poolShort>_<interval>.json
2. optimizer_high_resolution.ts   →   analysis/results/optimization_results_*.json
                                   →   profiles/market_profiles.json  (only with --write-profiles)
3. scripts/generate_lp_chart.ts   →   market chart + comparison chart  (visual review)
   - LP chart: `npm run lp:chart -- --data <lp-export.json>`
   - Local LP comparison alias: `npm run ama:chart:lp-local -- --data <lp-export.json>`
```

---

## Step 1 — Fetch LP Candles

`fetch_lp_candles.ts` fetches bidirectional LP swap data from Kibana through
the shared month-shard cache — the same cache `dexbot tv`/`dexbot dw` write —
then exports a full uncut candle file. Re-runs reuse the cached months and
query only the missing buckets; the whole-history file is a convenience
snapshot of the assembled shards.

**Known asset details:**

| Asset   | Symbol     | Object ID      | Precision |
|---------|------------|----------------|-----------|
| `<ASSET_A>` | `<ASSET_A>` | `<asset_a_id>` | `<n>`     |
| `<ASSET_B>` | `<ASSET_B>` | `<asset_b_id>` | `<n>`     |

**`<ASSET_A>`/`<ASSET_B>` pool (3 years):**
```bash
node dist/analysis/ama_fitting/fetch_lp_candles.js \
  --pool 1.19.133 \
  --assetA <ASSET_A> --assetAId <asset_a_id> --assetAPrecision <n> \
  --assetB <ASSET_B>     --assetBId <asset_b_id>    --assetBPrecision <n> \
  --hours 26280
```

Output: `market_adapter/data/lp/<pair_folder>/lp_pool_<poolShort>_<interval>.json` (interval-dependent)

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--pool` | required | Pool ID (e.g. `1.19.133` or just `133`) |
| `--assetA` | required | Asset A symbol |
| `--assetAId` | required | Asset A object ID (e.g. `<asset_a_id>`) |
| `--assetAPrecision` | required | Asset A precision |
| `--assetB` | required | Asset B symbol |
| `--assetBId` | required | Asset B object ID |
| `--assetBPrecision` | required | Asset B precision |
| `--interval` | `1h` | Candle interval label (`1m`, `5m`, `15m`, `1h`, `4h`, `1d`) |
| `--hours` | `26280` | Lookback hours (26280 = 3 years) |
| `--out` | auto | Output filename (default: auto-generated in `market_adapter/data/lp/<assetA>_<assetB>/`; used as-is if absolute) |

---

## Step 2 — Run the Optimizer

`optimizer_high_resolution.ts` runs a parallel geometric grid search over
ER × Fast × Slow combinations. Produces four AMA winners (AMA1–AMA4) using
different distance-cap quantiles and writes results to a JSON file + auto-generates
an interactive HTML chart.

By default this does **not** update runtime market-adapter profiles. Add
`--write-profiles` when you intentionally want the fitted parameters exported
to `profiles/market_profiles.json`.

**Run on the fetched LP data:**
```bash
node dist/analysis/ama_fitting/optimizer_high_resolution.js \
  --data market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json
```

**Export winners to the market adapter profile file:**
```bash
node dist/analysis/ama_fitting/optimizer_high_resolution.js \
  --data market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json \
  --write-profiles
```

Override ranges via CLI:
```bash
node dist/analysis/ama_fitting/optimizer_high_resolution.js \
  --data market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json \
  --erMin 100 --erMax 600 \
  --slowMin 800 --slowMax 6000
```

**AMA fitting caps:**

These are the active defaults used by the optimizer:

```bash
--ama1Cap 0.25  --ama2Cap 0.30  --ama3Cap 0.35  --ama4Cap 0.40
```

| Key  | Distance cap quantile | Character |
|------|-----------------------|-----------|
| AMA1 | 0.25 | Tightest fit, most reactive |
| AMA2 | 0.30 | Balanced |
| **AMA3** | 0.35 | Default |
| AMA4 | 0.40 | Widest fit, most conservative |

**AMA distance weights:**

The distance penalty λ balances movement smoothness against price closeness
(higher λ = AMA must stay tighter to price). Each AMA has a default weight;
override any individually:

```bash
# Defaults (built-in)
--ama1Weight 0.0031  --ama2Weight 0.0025  --ama3Weight 0.00185  --ama4Weight 0.0013

# Override only AMA1 and AMA4, keeping AMA2/AMA3 defaults
node dist/analysis/ama_fitting/optimizer_high_resolution.js \
  --data market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json \
  --ama1Weight 0.003 --ama4Weight 0.002
```

| Key  | Default λ | Character |
|------|----------:|-----------|
| AMA1 | 0.0031 | Heaviest distance penalty — most reactive, stays closest to price |
| AMA2 | 0.0025 | Moderate penalty |
| **AMA3** | 0.00185 | Default — balanced move-vs-distance tradeoff |
| AMA4 | 0.0013 | Lightest distance penalty — allows more room, most conservative |

**Inventory price range guidance:**

Use an inventory range that sits above the fitted cap so the market maker has
room to absorb normal noise without widening the book too much.

An optimized AMA plus the recommended buffer table is intended to provide a
relatively safe operating range for extreme market conditions while still
preserving reasonable inventory turnover.

- Safe buffer: `+10%` to `+15%` above the fitted cap
- Borderline: `+20%`
- Overkill: `+25%+`

| AMA  | Fitted cap | Safe inventory range | Borderline | Overkill |
|------|-----------:|----------------------:|-----------:|---------:|
| AMA1 | 25% | 35% to 40% | 45% | 50%+ |
| AMA2 | 30% | 40% to 45% | 50% | 55%+ |
| **AMA3** | 35% | 45% to 50% | 55% | 60%+ |
| AMA4 | 40% | 50% to 55% | 60% | 65%+ |

Source: pool 133 `IOB.XRP/BTS`, 1h candles, 2023-04-12 00:00 UTC through
2026-04-11 23:00 UTC (the working-tree dataset `analysis/ama_fitting/data/lp_pool_133_iob.xrp_bts_1h.json`, regenerated by a local `fetch_lp_candles.ts` run).

**Outputs:**
- `analysis/results/optimization_results_<datafile>_w<λ1>_<λ2>_<λ3>_<λ4>.json` — full results (e.g. `_w0_0031_0_0025_0_00185_0_0013`)
- `analysis/charts/optimization_chart_<datafile>_w<λ1>_<λ2>_<λ3>_<λ4>.html` — interactive AMA overlay chart (auto-generated)
- `profiles/market_profiles.json` — updated with new AMA parameters per pair only when `--write-profiles` is used

**Boundary check:** If a winner lands on the edge of the search range, the
optimizer warns you. Widen the affected range and re-run.

---

## Step 3 — Visual Review

A chart is auto-generated during Step 2 at
`analysis/charts/optimization_chart_<datafile>_w<λ1>_<λ2>_<λ3>_<λ4>.html`.
Open it in a browser to compare all four optimized AMA overlays against the
candlestick price.

For a standalone chart without re-running the optimizer (uses current defaults
from `modules/constants.ts` rather than optimized results):

```bash
npm run lp:chart -- \
  --data market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json
```

This generates both:
- `analysis/charts/lp_AMA_chart_pool_133.html` — market-adapter style LP chart
- `analysis/charts/lp_chart_pool_133.comparison.html` — AMA comparison chart (derived from LP metadata)

The unified comparison chart (`*_UNIFIED_COMPARISON.html`) is produced by
`npm run ama:chart:lp-local` (see workflow overview above).

---

## How market_profiles.json is used

When the optimizer is run with `--write-profiles`, `profiles/market_profiles.json`
is updated with the new AMA1–AMA4 parameters for the pair. The market adapter
reads this file at startup and on each cycle via `_resetCycleCache()` /
`findAmaProfileForBot()` in `market_adapter/market_adapter.ts` (lines 127 and 346 respectively). No restart
required — takes effect on the next market adapter cycle.

---

## Auxiliary Tools

### `calibrate_convergence_er.ts`

Computes the implied `AMA_CONVERGENCE_ER_AVG` for `modules/constants.ts` from
real LP candle data. Accounts for Jensen's inequality: the average smoothing
constant is not the smoothing constant of the average ER.

```bash
node dist/analysis/ama_fitting/calibrate_convergence_er.js --data <lp-file.json> --amas AMA3
```

### `analyze_lambda_vs_slow.ts`

Fixes ER and Fast at the AMA1 defaults (781 / 5.2), then scans λ (distance weight)
over a range to find the optimal Slow period for each λ. Produces a 3-panel chart:
λ→Slow, λ→Movement, and Slow→Movement (all cached slow values from 10 to maxSlow).

Useful for understanding how λ shapes the optimal Slow independent of ER/Fast
variation. The annotations on the λ→Slow chart mark where the four default AMA λ
values land on the curve — differences of ±1–2 slow units vs the 3-D optimizer
are expected since the optimizer also tunes ER and Fast simultaneously.

```bash
node dist/analysis/ama_fitting/analyze_lambda_vs_slow.js \
  --data <lp-file.json> --maxSlow 250 --lambdaEnd 0.0045 --lambdaSteps 50
```

### `analyze_ama_price_changes.ts`

Simulates `AMA_DELTA_THRESHOLD_PERCENT` grid-reposition frequency for all four
AMA series on LP candle data. Reports reposition counts and inter-reposition
step distributions.

```bash
node dist/analysis/ama_fitting/analyze_ama_price_changes.js \
  --data <lp-file.json> --results <optimization-results.json>
```

---

## Data file format

```json
{
  "meta": {
    "pool": "1.19.133",
    "assetA": { "id": "<asset_a_id>", "precision": <n>, "symbol": "<ASSET_A>" },
    "assetB": { "id": "<asset_b_id>",    "precision": <n>, "symbol": "<ASSET_B>" },
    "intervalSeconds": 3600,
    "lookbackHours": 26280,
    "candleCount": 26280
  },
  "candles": [
    [timestamp_ms, open, high, low, close, volume_A],
    ...
  ]
}
```

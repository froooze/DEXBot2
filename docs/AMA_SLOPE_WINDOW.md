# AMA-Slope Window Decision — 16h + Persistence Gate

Status: **applied** (window `20` → `16`, persistence gate enabled by default).
Related: `docs/GRID_RECALCULATION.md` §4, `market_adapter/README.md`,
`analysis/trend_detection/README.md`, `analysis/tradingview/README.md`.

## Decision

- `MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS`: **20 → 16** (Huber window).
- `MARKET_ADAPTER.AMA_SLOPE_PERSIST_ENABLED`: **false → true**; gate length
  `AMA_SLOPE_PERSIST_BARS = 3`.

No estimator change. The canonical slope stays `computeHuberWindowSlopePct`
(Huber-robust regression of `ln(AMA)`).

## Why

The window and the gate are coupled. A shorter window is more responsive but
noisier; the gate removes the noise-driven resets while adding at most K−1 bars
to the surviving slope resets (the independent price/Drift trigger is
unaffected), so together they dominate either knob alone.

Measured on a live 1h market-pair pool (AMA3, fixed centred reference
half-window 24 bars, via `backtest_ama_slope_huber.ts --truth-window 24`):

| config | resets | rs/day | whip% | amaLag | revLag | wobble | zc/1k | wrongWay% |
|---|---|---|---|---|---|---|---|---|
| 20h, ungated (old) | 1467 | 1.45 | 52 | 10 | 22 | 0.00083 | 5.37 | 13.8 |
| 20h + K=3 | 960 | 0.95 | 16 | 10 | 22 | 0.00083 | 5.37 | 13.7 |
| **16h + K=3** | **962** | **0.95** | **17** | **8** | **20** | 0.00090 | 5.77 | **12.6** |
| 14h + K=3 | 975 | 0.96 | 18 | 7 | 18.5 | 0.00094 | 6.08 | 12.7 |

16h + K=3 vs the old 20h-ungated:
- **Churn collapses**: resets 1467 → 962 (~35% fewer), resets/day 1.45 → 0.95,
  whipsaw 52% → 17%.
- **Lag improves**: AMA group delay 10 → 8 bars; reversal-confirmation lag 22 → 20.
- **Range tilt points wrong less often**: 13.8% → 12.6% of forward windows.
- **Cost**: slope wobble +8%, zero-crossings +7%. That is the noise the gate
  absorbs at the decision layer (it never changes the slope value itself).

16h is the knee; below it, returns diminish (14h buys 1 more bar of lag for
+1.6% resets and +4% wobble).

Reproduce:

```bash
node dist/analysis/trend_detection/backtest_ama_slope_huber.js \
  --data market_adapter/data/lp/<market-pair> \
  --lookback 20:8:2 --truth-window 24   # add --slope-persist 1 for the ungated row
```

`amaLag` is robust to the reference half-window; `revLag` scales with it, so
compare `revLag` across runs only at a fixed `--truth-window`. The LP shards are
refreshed by live collection, so reset counts can drift by ±1 from the table.

## Huber scale estimate — why `C` stays 1.345

The robust scale is a **plug-in** `1.4826 * MAD` of the fit's own residuals;
with two fitted parameters those are shrunk, so it reads low by `≈ 1/(bars − 1)`
and the **effective** Huber constant is ~1.25 at 16 bars (nominal 1.345).
Compensating it (a `sqrt(n/(n-2))` correction, or a proposal-2 M-scale) is
**decision-neutral** — wobble, lag, reset counts and wrong-way all within noise
— and gives up more robustness (~0.8% RMS under 10% contamination) than it
recovers in efficiency (~0.4% clean). So the detune is left in place: it makes
short windows more conservative, the safe direction for a trend filter. The
outlier diagnostic is the only metric that moves.

```bash
node dist/analysis/trend_detection/backtest_ama_slope_huber.js \
  --data market_adapter/data/lp/<market-pair> --scale-mode none|df|mscale
```
(`none` == production; see `analysis/trend_detection/huber_scale_variants.ts`.)

## EMA on the slope — default alpha 0.2

The published `slopePct` (and therefore the offset channel and the grid-reset
delta) is now a recursive EMA over the per-bar Huber slope, not the raw Huber
reading:

```
ema[i] = ema[i-1] + alpha * (huberSlope[i] - ema[i-1])
```

`computeAmaSlopeEmaSeries` in
`market_adapter/core/strategies/dynamic_weight_series.ts` is the single
definition, embedded verbatim into the DW research chart via
`embedFunctionSources`. `alpha = 1` reproduces raw Huber bit-for-bit.

Default `MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_SLOPE_EMA_ALPHA = 0.2` adds
`(1-alpha)/alpha ≈ 4` bars of lag and, on the sparse 12-month pool sample, cuts
the worst bar-to-bar slope jump by ~60% (0.076 → 0.032 %/bar) without changing
the slope distribution's median or p90. Range `[2/101, 1]`: `2/101` is the
100-bar variance-equivalent alpha (`2/(N+1)`), `1` disables smoothing.
Override per deployment via `MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_SLOPE_EMA_ALPHA`
in `profiles/general.settings.json`, or per market/bot via
`amaSlope.emaAlpha` in `profiles/market_adapter_settings.json`.

The clip threshold is intentionally still derived from the raw slope history,
so adding EMA does not create a clip-feedback loop. Because the reset baseline
is persisted, the first cycle after enabling EMA compares a smoothed reading
with the previously stored raw baseline; magnitudes are close and the gate is
direction-aware, so this normally costs at most one recenter. Rollback: set
`amaSlope.emaAlpha: 1` (or the global constant to `1`) — no schema change.

**Operational sign-off — slower reversal response.** Smoothing is bought with
lag: at the default `alpha = 0.2` the EMA mean lag is `(1-alpha)/alpha ≈ 4`
bars. The slope-delta reset then still needs `AMA_SLOPE_PERSIST_BARS`
consecutive confirming bars (default `3`), so a genuine trend reversal needs
roughly **7 confirming bars** before the grid recenters, versus about `3` on
raw Huber. Sparse pools trade fewer bars per day, so that delay can be material
in wall-clock time. Enabling the default (any `alpha < 1`) on live bots is an
explicit operational decision: accept the slower reversal in exchange for
one-trade spike suppression, or tune `amaSlope.emaAlpha` toward `1` and/or
`amaSlope.persistBars` down where fast recentering matters more. Setting
`amaSlope.emaAlpha: 1` restores the original confirmation count without
touching any other setting.

## Fill-model drawdown — the window effect is pool-dependent

Paired persistent-grid runs (`simulatePersistentGrid`, geometry fixed,
`asymmetricBounds` on) show the window does move fill-model economics, but
**with no stable sign across pools**: on a long-lived liquid pair 16h beat 12h
on realized drawdown (−8.9 pts, lower in 108/108 geometries) and net capture
(+26 pts) at equal activity, while on a shorter pair the ordering reversed. So
it supports keeping the shipped 16h without being a general economic proof.
Trust the paired delta, not the absolute level (realized-equity DD is
model-shaped and can exceed capital).

```bash
node dist/analysis/bot_fitting/backtest_lookback_drawdown.js \
  --data market_adapter/data/lp/<market-pair> --lookbacks 12,16
```

## Rejected alternative — Kalman slope estimator

A constant-velocity Kalman filter on `ln(AMA)` was implemented, unit-tested
(bar-for-bar parity with the live `KalmanFilter` class) and benchmarked. It cut
lag ~2 bars at matched churn, but:
- it required a stateful estimator, chart re-embedding, adapter restructuring,
  a persisted estimator id + baseline re-seed, and a flag rollout — a real
  migration/correctness surface for a latency-only gain;
- the fill model could not turn the lag win into a profit win (estimator
  differences within model noise, marginally favouring the incumbent);
- range wrong-way was estimator-independent (~13.5% for both).

So it was removed completely in favour of the zero-migration window change.

## Interactions updated

- `modules/constants.ts` — the two defaults + comments.
- `profiles/general.settings.json` — the local (gitignored) override set to `16`
  so the running config agrees with the code default.
- `market_adapter/core/strategies/dynamic_weight_series.ts` — comments.
- `analysis/tradingview/grid_reset_config.ts` — resolves `slopePersistBars`
  (per-bot override → global enable/value → legacy 1) and exports it in
  `toGridSimPayload`, so the embedded chart replay fires the same Δs resets the
  live adapter does. The panel prints `persist K`.
- `analysis/tradingview/tradingview_uplot_chart_generator.ts` — spreads the gate
  into `simulateGridResetSeries` (via `gridSimCfg`) and shows it in the panel.
- `analysis/tradingview/grid_reset_sim.ts` — the persistence gate itself.
- `market_adapter/core/market_adapter_service.ts` — adapter gate
  (`resolveAmaSlopePersistBars` / `advanceAmaSlopePersistence`, state persisted in
  `botState.amaSlopePersistCount` / `amaSlopePersistDir`).
- `analysis/bot_fitting/backtest_bot_fitting.ts` — gate + `bandTilt` fill-model
  hooks (used by the comparison harness). Trigger B and the grid price offset
  now replay the canonical Huber → EMA slope instead of raw Huber, so their
  reset cadence matches the live published slope; `--slope-ema-alpha` pins a
  what-if alpha (`1` = raw Huber). The same replay is used by
  `backtest_ama_sweep.ts` (which also exposes the flag) and by
  `backtest_lookback_drawdown.ts` (production default, no flag).
- Docs: `docs/GRID_RECALCULATION.md`, `market_adapter/README.md`,
  `analysis/trend_detection/README.md`, `analysis/tradingview/README.md`.
- Research (new): `analysis/trend_detection/huber_scale_variants.ts` and
  `analysis/bot_fitting/backtest_lookback_drawdown.ts`, with `--scale-mode` on
  `backtest_ama_slope_huber.ts`, `--lookback` on `backtest_ama_sweep.ts`, and
  `tests/test_huber_scale_variants.ts`.

## Operational notes

- **Live behaviour change.** Both edits are active by default. The window change
  moves `readyBars = erPeriod + lookbackBars` by −4 bars (faster post-restart
  convergence).
- **Restart transient.** The gate counters persist across restarts; a pending
  count is cleared by any successful reset.
- **Baseline transient.** The persisted `gridRangeScalingAmaSlope` baseline was
  written by the 20h window; the first post-deploy cycle compares a 16h reading
  against it. Magnitudes are close (the delta is usually below the reset gate),
  but a bot whose slope sits near the threshold can cost one extra recenter,
  once — the same class of effect as the Huber swap, with no version marker to
  suppress it.
- **Rollback.** Window: set `DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS` back to `20`.
  Gate: `AMA_SLOPE_PERSIST_ENABLED = false` (or `amaSlope.persistEnabled: false`
  / `amaSlope.persistBars: 0` per bot). No schema change.
- **Caveat.** Proxy-scored. The fill model lacks queue-position loss and adverse
  selection, so the economic benefit is not conclusively demonstrated; validate
  in shadow mode before relying on it. The churn/lag/wrong-way wins are robust
  across six markets. The fill-model drawdown comparison (above) found a real
  per-pool window effect but with a pool-dependent sign, so it does not convert
  this into a general economic proof.

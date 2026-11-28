# Dynamic Weight Research Tool

Interactive HTML chart for researching optimal dynamic weight parameters by blending AMA slope and Kalman filter signals, gated by Hurst Exponent and Permutation Entropy regime detection.

## Overview: What are AMA and Kalman?

The DEXBot2 dynamic weight system combines two fundamentally different trend-detection methods, each compensating for the other's weaknesses. This section explains what they are and why they are used together.

### AMA — Adaptive Moving Average

A traditional moving average (SMA, EMA) smooths price with a fixed window — it treats every bar equally, whether the market is trending or choppy. That means it's always either too slow (in trends) or too jittery (in chop).

An **Adaptive Moving Average** (AMA) — specifically the Kaufman variant (KAMA) — self-adjusts its smoothing speed based on market efficiency. It uses the **Efficiency Ratio (ER)**:

```
ER = |Close[t] − Close[t−N]| / Σ |Close[i] − Close[i−1]|
```

Crucially, the input start price used to seed the AMA calculation is an **SMA (Simple Moving Average)** derived from the initial ER buffer window. Using an SMA rather than a single raw closing price ensures that the baseline is resistant to anomalous price spikes during the initialization phase, providing a more stable anchor before the recursive AMA formula begins. During this warmup phase, the history buffer is filled to allow the calculation of the Efficiency Ratio (ER) and the subsequent adaptive trend tracking.

Think of ER as "how much net progress did price make, divided by how much it zigzagged to get there":

| ER value | Market state | AMA behavior |
|----------|-------------|--------------|
| **ER ≈ 1** | Trending (efficient) | Moves fast — tracks each bar closely |
| **ER ≈ 0.5** | Mixed | Moderate smoothing |
| **ER ≈ 0** | Choppy (noisy) | Barely moves — ignores the noise |

**Why it matters**: In a strong trend, the AMA hugs price tightly so the bot can follow. In a sideways chop, the AMA flattens out, so the bot doesn't get whipsawed into bad entries. The AMA is *noise-filtering at the source* — a flat line genuinely means there is no trend, not that up and down bars happened to average out.

### Kalman Filter — A State Estimator

A moving average (even an adaptive one) is ultimately a *smoothing* tool. It takes noisy data and blurs it. A **Kalman filter** is fundamentally different — it is a **state estimator** that builds an internal model of the underlying system and updates it as new measurements arrive.

The Kalman filter answers: "Given the noisy price I just saw, what do I *actually* believe the true price and velocity are?"

It works by maintaining two internal numbers:

- **R (measurement noise)**: How much random wick/jitter do I expect in each price bar? High R → the filter trusts new measurements less.
- **Q (process noise)**: How much genuine price change do I expect per bar? High Q → the filter trusts its velocity model less, allowing faster adaptation.

By tuning Q differently, the same algorithm produces two distinct views:

| Filter | Q setting | What it tells you | Analogy |
|--------|-----------|-------------------|---------|
| **Tactical** (velocity) | High Q | Direction and speed *right now* — fast to catch inflections, slow to react to wicks | "Which way is the wind blowing this moment?" |
| **Modal** (displacement) | Very low Q | How far price has drifted from its long-run equilibrium — slow-moving center of gravity | "How far from home are we?" |

**Why it matters**: Because the Kalman filter models *velocity* and *position* as separate states, it can tell the difference between a real trend (both agree) and a random spike (velocity jumps but displacement stays near zero). A moving average can't do this — it just averages everything together.

### Why blend them?

| | AMA | Kalman |
|---|---|---|
| **Strength** | Simple, robust; ER is intuitive and proven | Models velocity & displacement separately; state-space awareness |
| **Weakness** | Only sees efficiency, not momentum direction vs. equilibrium | Heavier computation; needs warmup; tuned poorly it overfits |
| **Best in** | Clean trends where ER is unambiguous | Mixed conditions where separating wicks from real moves matters |

Blending them via the **α** knob (0 = pure Kalman, 1 = pure AMA) lets you dial in the right balance for each market. The goal is to confirm trends from two independent angles before committing weight.

On top of this blend, **Hurst Exponent** and **Permutation Entropy** act as a regime gate — when the market is too random, the entire directional signal is dampened (never amplified), protecting the bot from trading noise.

## Quick Start

```bash
# One-step (recommended): same fetch pipeline as `dexbot tv` — bot, pool, or pair
dexbot dw <bot-key>
dexbot dw 133 --month 6
dexbot dw TOKENA/TOKENB --month 1

# From JSON candle file
node dist/analysis/analyze_dynamic_weight.js \
  --file market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json

# With custom initial parameters
node dist/analysis/analyze_dynamic_weight.js \
  --file market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json \
  --alpha 0.6 \
  --gain 0.25 \
  --clip 20
```

Output: `analysis/charts/dynamic_weight_chart.html` (open in browser)

`dexbot dw` writes an auto-named chart instead: `analysis/charts/dw_<bot|pool_<id>|<a>_<b>>_1h_<N>m.html`.

**Note**: Hurst requires 256 bars and PE requires 58 bars before their regime signals become active. The first portion of the chart will show the full weight without regime gating.

## CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--source` | `market_adapter` | Data source type (`json`, `market_adapter`) |
| `--file` | — | Path to JSON candle file (implies `--source json`) |
| `--bot-key <key>` | — | Bot key from `profiles/bots.json` (required) |
| `--chart` | `analysis/charts/dynamic_weight_chart.html` | Output HTML path |
| `--alpha` | `0.5` | Initial α blend (0 = pure Kalman, 1 = pure AMA) |
| `--dw` | `0.50` | Initial displacement weight (0 = pure velocity, 1 = full displacement) |
| `--lb` | `16` | Initial lookback bars (4-32) for AMA slope calculation |
| `--gain` | `1.0` | Initial gain multiplier |
| `--clip` | `10` | Initial clip percentile |
| `--quiet` | `false` | Suppress console output |

## Chart Layout

Four stacked uPlot panels with synchronized zoom/pan (scroll to zoom, drag to pan, Ctrl+0 to reset):

All panels share aligned vertical time grid lines, and the bottom output panel shows the readable date axis so the visible time frame stays obvious while zooming and panning.

### Panel 1 — Log Price (34%)
- **Blue line**: Price on logarithmic y-axis
- **Gold line**: AMA3 (slow KAMA from `constants.ts`, erPeriod=781) for macro trend reference
- Background shading: green = BULL signal, red = BEAR signal

### Panel 2 — AMA Slope Input (14%)
- **Orange line**: AMA3 slope percentage
- Shows the directional strength of the slow KAMA's trend movement
- Values outside the clip threshold are flattened before entering the offset formula
- Background shading mirrors the output signal direction

### Panel 3 — Kalman Composite Input (21%)
- **Purple line**: Kalman velocity percentage, adaptively smoothed in sideways regimes
- **Cyan dashed line**: Kalman displacement percentage (modal filter — distance from fair-value price)
- Velocity measures *direction and speed* of price movement
- Displacement measures *how far price has already moved* from equilibrium

### Panel 4 — Combined Weight Output (remaining ~31%)
- Green/red fill: positive offset (buy weight increases, sell weight decreases) vs negative offset (sell weight increases, buy weight decreases)
- Legend shows: offset value, sell weight (S), buy weight (B)
- Interactive knobs for real-time parameter tuning
- Weight amplitude is scaled by the Hurst+PE regime multiplier on each bar

## Interactive Knobs

### Blend Controls
| Knob | Range | Default | Purpose |
|------|-------|---------|---------|
| **α** | 0–1 | 0.5 | Blend ratio between AMA and Kalman channels (0 = pure Kalman, 1 = pure AMA) |
| **dw** | 0–1 | 0.5 | Displacement weight: how much Kalman displacement influences the composite signal |

### Kalman Smoothing
| Knob | Range | Default | Purpose |
|------|-------|---------|---------|
| **kf** | 0–200 | 100 | Sideways-regime Kalman smoothing blend (0 = raw velocity, 100 = current adaptive smoothing, 200 = stronger smoothing) |
| **kfd** | 1–3x | 1.80x | Displacement scale multiplier for the adaptive smoothing confidence ramp |
| **dsp** | 0.25–4x | 1.00x | Minimum displacement scale floor used by the Kalman confidence ramp |
| **kdt** | 0.25–3x | 1.50x | Displacement threshold multiplier for when the adaptive EMA starts to loosen |
| **kfs** | 20–200% | 100% | Adaptive EMA span ratio |
| **cf** | 0–5 | 0 | Signal confirmation bars for the latched/raw signal overlay |

**Adaptive EMA (kf, kfs, kdt, kfd)**: When displacement is near equilibrium, the Kalman velocity is low-pass filtered more aggressively — trimming whipsaws in sideways chop while keeping fast reaction in trends. Behavior:
- `kf = 0` → raw Kalman velocity (no smoothing)
- `kf = 100` → current adaptive EMA result
- `kf > 100` → pushes further toward the adaptive signal (up to 200)

**dsp (displacement scale)**: Controls how fast displacement confidence saturates. Smaller values make it saturate faster (less displacement needed for full confidence); larger values require more displacement. The live default is `1.0` (`DYNAMIC_WEIGHT_DISP_SCALE_MIN_PCT`); neither the live adapter nor the chart clamps it above or below that, so the slider's `0.25` floor is usable in both.

**Latched signal (cf)**: Prevents the output from flip-flopping on every bar. It holds the last direction for `cf` bars before allowing a reversal:
- `cf = 0` → raw signal (instant flips)
- `cf = 1` → flips on the first opposite bar
- `cf = 2–5` → requires that many consecutive opposite bars before changing direction
- Neutral bars preserve the current latched state without resetting the confirmation count.

### Slope Calculation
| Knob | Range | Default | Purpose |
|------|-------|---------|---------|
| **nz%** | 0–1 | 0.00 | Neutral zone: dead-band below which offset is forced to 0 |
| **lb** | 8–100 | 16 | Logarithmic. Lookback bars for the Huber AMA slope fit |
| **ema** | 0.0198–1 | 0.2 | Logarithmic. EMA alpha on the slope series: left = 1 (off), right = 100-bar equivalent (`2/(N+1)`). Same helper/default as the live adapter |
| **amaS%** | 0.06–0.12 | 0.1 | Logarithmic. Gear ratio for per-bar AMA slope saturation |
| **kalS%** | 0.75–1.5 | 1.2 | Logarithmic. Gear ratio for Kalman composite saturation |
| **clip%** | 0–20 | 10 | Percentile clip: filters extreme inputs (0 = off) |

### Output Controls
| Knob | Range | Default | Purpose |
|------|-------|---------|---------|
| **th%** | 0–0.5 | 0.00 | Minimum pre-gain blended output required before the signal is allowed through |
| **gain** | 0.5–2.0 | 1.0 | Logarithmic. Amplitude multiplier on the clamp-normalized blend |
| **regi** | 0–2 | 1.0 | Regime sensitivity: exponent applied to Hurst+PE multiplier |

## Copy / Paste Parameters

The **copy** button serializes all knob values (α, dw, kf, kfd, dsp, kdt, kfs, cf, lb, ema, amaS%, kalS%, th%, gain, clip%, nz%, regi) to JSON and writes them to both the clipboard and `localStorage`.

The **paste** button first checks `localStorage` for parameters from a previous copy in the same browser session. If none found, it prompts for Ctrl+V input. A confirmation popup shows the parsed values before applying them. Click **Apply** to set the knobs, **Cancel** or press **Escape** to dismiss.

## Signal Design Rationale

*The Overview explains what AMA and Kalman are. This section covers why specific design choices were made and how the supporting machinery (regime detection, volatility penalty) fits together.*

### AMA slope

Taking the slope of the AMA produces a signal that is already noise-filtered at the source — a near-zero slope genuinely means sideways, not oscillation that happened to average out. The canonical slope is a Huber-robust linear regression of `ln(AMA)` over the lookback window (per-bar log-return ×100, `MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_HUBER`), so a single outlier bar is discounted instead of getting full endpoint weight; the same estimator runs in the live adapter, both research charts, and the reset replay. The **ema** knob then applies a recursive EMA to those per-bar slopes (`computeAmaSlopeEmaSeries`, embedded in this chart and called by the live adapter): it trims single-trade spikes with ~`(1-alpha)/alpha` bars of lag instead of lengthening the Huber window. The neutral zone (`nz%` knob) dead-bands any remaining micro-slope residuals.

### Kalman filter

Running two Kalman filters at different Q values gives two orthogonal signals — velocity (immediate direction) and displacement (distance from equilibrium). They carry different information and are kept in separate chart panels. The `dw` knob only adds displacement confidence when the two signals agree on direction, avoiding false confirmation from opposing signals.

### ATR and symmetric volatility penalty

**ATR** (Average True Range) measures how wide price bars are — a direct gauge of market volatility. High volatility means wider spreads and more risk of sudden reversals.

The research tool intentionally sets ATR to zero to isolate the directional signal. In production, ATR drives a **symmetric volatility penalty**: when volatility is high, both buy and sell weights are reduced equally, keeping the bot out of turbulent conditions. This penalty is a separate branch from the directional Kalman/AMA signal — the two effects are applied independently and never double-count each other.

**Variables and formula:**

- `weightVariance` = `atr / amaPrice`
- `volatilityExponent` = power applied to the variance
- `volatilityScaleX` = penalty multiplier in x-factor units (10× default, 1×–100× in the volatility chart)
- `volatilityThreshold` = minimum absolute shift before the penalty is allowed through
- `MAX_SYMMETRIC_SHIFT` = default cap on the downward shift (overrideable in live settings)

```text
rawSymmetricDelta = -pow(weightVariance, volatilityExponent) * volatilityScaleX
clampedRawDelta   = clamp(rawSymmetricDelta, -MAX_SYMMETRIC_SHIFT, 0)
symmetricDelta    = |clampedRawDelta| < volatilityThreshold ? 0 : clampedRawDelta
```

Applied to weights:
```text
effectiveSell = clamp(staticSell - trendOffset + symmetricDelta, MIN_WEIGHT, MAX_WEIGHT)
effectiveBuy  = clamp(staticBuy  + trendOffset + symmetricDelta, MIN_WEIGHT, MAX_WEIGHT)
```

The dedicated volatility research chart in `analysis/analyze_volatility.ts` uses the same math without any directional component.

### Hurst Exponent

Estimates the long-memory property of the price series via Rescaled Range (R/S) analysis over a rolling window of 256 bars with scales `[8, 16, 32, 64]`.

The regime bands below are project heuristic defaults, not fitted market-specific
thresholds.

| H value | Regime | Meaning |
|---|---|---|
| H > 0.55 | TRENDING | Returns are persistent — trends continue |
| H ≈ 0.5 | RANDOM | No memory — random walk |
| H < 0.45 | MEAN_REVERTING | Returns are anti-persistent — reversals dominate |

**Algorithm**: for each scale τ, partition the log-return window into non-overlapping chunks of length τ, compute the average R/S (Rescaled Range) per chunk, then OLS-fit `log(avgRS)` vs `log(τ)` — the slope is the Hurst exponent.

**Role**: Hurst is one axis of the regime multiplier matrix. Gates the AMA+Kalman blend in production when `regimeSensitivity > 0`.

**Warmup**: requires 256 bars before `isReady = true`.

### Permutation Entropy

Measures market disorder by counting ordinal (rank-order) patterns in a rolling window of 54 bars, with embedding dimension `m=5` and delay `1`.

The regime bands below are project heuristic defaults, not fitted market-specific
thresholds.

| Normalized PE | Regime | Meaning |
|---|---|---|
| PE < 0.60 | STRUCTURED | Price movement is ordered — signals are trustworthy |
| 0.60–0.85 | MIXED | Partial structure |
| PE > 0.85 | NOISE | Maximum disorder — no reliable edge |

**Algorithm**: for each position `i` in the window, extract the rank-order of `[price[i], price[i+1], ..., price[i+m-1]]` as an ordinal pattern key. Compute Shannon entropy over the distribution of all `m! = 120` possible patterns, normalized by `log(m!)` to give PE ∈ [0, 1].

**Role**: PE is the second axis of the regime multiplier matrix. It complements Hurst — Hurst identifies trend persistence, PE identifies signal quality. Together they gate the applied directional offset.

**Warmup**: requires 58 bars (`window + (m-1) * delay`) before `isReady = true`.

### Regime Multiplier

Hurst and PE are combined into a single regime multiplier via bilinear interpolation over a 3×3 lookup table:

```
                PE < 0.60     PE 0.725     PE > 0.85
                (Structured)  (Mixed)      (Noise)
H > 0.55  →    1.0           0.7          0.3
H 0.45–0.55 →  0.6           0.4          0.15
H < 0.45  →    0.3           0.2          0.05
```

Best case (trending + structured): multiplier = **1.0** (full signal). Unclear situations < 1.0 to dampen signal.

The `regi` (regime sensitivity) knob raises the multiplier to a power: `finalMult = baseMult ^ sensitivity`. At sensitivity = 1.0 (default), the table is used as-is. Higher sensitivity exaggerates regime differences; lower sensitivity flattens them toward 1.0.

**Dampen-only**: the multiplier is clamped to a maximum of 1.0. Regime can only reduce the signal — it never amplifies above what the blended channels and output clamp already allow. This was found to perform better in practice: letting a "good" regime boost the signal over-commits when the signal is already at its natural peak.

The lookup table can be customized per-market or per-bot (see [Custom Configuration](#regime-table-custom-configuration)). The default values match the table above.

## Formulas

### AMA Offset
```
amaSlope% = ((AMA_now − AMA_lb_bars_ago) / AMA_lb_bars_ago × 100) / lb
amaClip = clamp(amaSlope%, ±clipThreshold)    // percentile-based clip
amaOff  = clamp(amaClip / amaS% × outputClamp, ±outputClamp)
```

### Kalman Composite Offset
```
kalClip   = clamp(velocity%, ±clipThreshold)   // percentile-based clip
dispConf  = min(|displacement%| / dsp, 1)       // displacement confidence, 0–1
momAlign  = sign(kalClip) == sign(displacement%) ? 1 : 0
kalComp   = kalClip × (1 − dw + dw × dispConf × momAlign)
kalOff    = clamp(kalComp / kalS% × outputClamp, ±outputClamp)
```

### Regime Multiplier
```
baseMult  = bilinear(REGIME_TABLE, H, PE)      // 0.05–1.0 depending on regime
rawMult   = baseMult ^ regimeSensitivity        // power scaling via regi knob
finalMult = min(rawMult, 1.0)                  // dampen-only: regime never amplifies
```

### Final Weight (clamp-normalized blend + gain)

Each channel is normalized by the configured output clamp before blending, so α stays a pure ratio knob. The dead-band is applied to that pre-gain blended shape first; `gain` then scales the surviving signal linearly at the end:

```
cap            = configured channel clamp
channelNorm    = max(|cap|, ε)
blendedOff     = (α × (amaOff / channelNorm) + (1 − α) × (kalOff / channelNorm))
gatedOff       = |blendedOff × finalMult| < minOutputThreshold ? 0 : (blendedOff × finalMult)
off            = gatedOff × gain
sellW = 0.5 + off
buyW  = 0.5 − off
```

The research chart intentionally plots the unclamped `off` series so moves above the runtime cap stay visible. The clamp guides still show where the live adapter would stop applying additional directional offset.

`th%` maps to `minOutputThreshold`. It is applied after the AMA/Kalman blend and regime multiplier, but before `gain`, so it controls which small blended moves are zeroed out rather than how the remaining moves are scaled.

## Parameter Relationships

### amaS% / kalS% + maxSlopeOffset + gain

These knobs have separate jobs:
- `amaS%` = gear ratio for how quickly AMA slope reaches full directional strength
- `kalS%` = gear ratio for how quickly the Kalman composite reaches full directional strength
- `maxSlopeOffset` / `outputClamp` = channel clamp used to normalize the AMA and Kalman rails
- `gain` = final output scale after the blended shape has already been decided

### α (blend)
- 0 = pure Kalman (momentum + displacement composite)
- 1 = pure AMA slope
- 0.5 = equal blend

Each channel is normalized to the same clamp before blending, so changing α shifts the ratio between AMA and Kalman without changing their relative scale. Gain then scales that already-decided shape linearly, without changing where the chart gates to zero.

### nz% (neutral zone)
Values below `nz%` in absolute terms are zeroed out before the offset formula.

### dw (displacement weight)
Controls how much the Kalman displacement (distance from equilibrium) influences the composite signal:
- Default: `dw = 0.50`
- `dw = 0`: Pure velocity — only direction and speed matter
- `dw = 1`: Full displacement weighting — adds confidence when velocity and displacement agree on direction
- Only active when `momAlign = 1` (velocity and displacement have same sign)

Formula: `kalComp = clippedV × (1 − dw + dw × dispConf × momAlign)`

### lb (lookback bars)
Number of bars to look back when computing AMA slope:
- `lb = 4`: Very short-term, highly responsive to recent price action
- `lb = 16` (default): ~16 hours of hourly candles, balanced responsiveness and smoothing
- `lb = 32`: ~1.3 days of hourly candles, stable but slower to react

AMA slope is a per-bar log-return (Huber regression of `ln(AMA)`), not the cumulative move across the full lookback. Lower values = more noise, faster reaction. Higher values = smoother signals, more lag without adding gain just because the measurement window is longer.

### regi (regime sensitivity)
- 0 = regime multiplier is always 1.0 (Hurst+PE ignored)
- 1 = default table values used as-is
- 2 = regime differences are squared (strong gating effect)

Regime is **dampen-only**: the multiplier is capped at 1.0 regardless of sensitivity. A favorable regime (trending + structured) passes the signal through unchanged; an unfavorable regime reduces it.

### Regime Table (Custom Configuration)

The 3×3 regime multiplier table can be customized per-market or per-bot (default values match the table in [Regime Multiplier](#regime-multiplier)):

```json
{
  "marketAdapterSettings": {
    "regimeTable": [
      [1.0, 0.7, 0.3],
      [0.6, 0.4, 0.15],
      [0.3, 0.2, 0.05]
    ]
  }
}
```

## Data Pipeline

```
Candle Data
├── AMA3 (slow KAMA, erPeriod=781)
│   ├── calculateAMA() → AMA3 values per bar  [price panel overlay]
│   ├── computeAmaSlopeWeights() → Huber slope% (ln-return per bar)
│   └── Percentile clip → amaClip → amaOff
│
├── Kalman Filter (tactical + modal)
│   ├── KalmanTrendAnalyzer.update() → velocity%, displacement%, signal, isReady
│   └── Percentile clip → kalClip → composite → kalOff
│
├── Hurst Exponent  (window=256, scales=[8,16,32,64])
│   └── HurstAnalyzer.update() → hurst, regime            [regime multiplier axis]
│
├── Permutation Entropy  (m=5, delay=1, window=54)
│   └── PermutationEntropyAnalyzer.update() → normalizedEntropy, regime  [regime multiplier axis]
│
├── Regime Multiplier
│   └── min(bilinear(REGIME_TABLE, H, PE) ^ regimeSensitivity, 1.0) → finalMult  [dampen-only]
│
└── Normalized blend × regime multiplier
    blendedOff = (α·(amaOff / cap) + (1−α)·(kalOff / cap))
    gatedOff   = |blendedOff × finalMult| < minOutputThreshold ? 0 : (blendedOff × finalMult)
    off        = gatedOff × gain
    ├── sellW = 0.5 + off
    └── buyW  = 0.5 − off
```

## Key Files

| File | Role |
|------|------|
| `analysis/analyze_dynamic_weight.ts` | Runner: loads data, computes all signals, generates chart |
| `analysis/trend_detection/dynamic_weight_chart_generator.ts` | HTML generator: 4-panel uPlot chart with interactive knobs |
| `market_adapter/core/signals/kalman_trend_analyzer.ts` | Kalman filter with tactical/modal state tracking (re-export shim at `analysis/trend_detection/kalman_trend_analyzer.ts`) |
| `market_adapter/core/signals/kalman_velocity_smoothing.ts` | Adaptive EMA smoothing for Kalman velocity (kf/kfd/kdt/kfs knobs; shim at `analysis/trend_detection/kalman_velocity_smoothing.ts`) |
| `market_adapter/core/signals/hurst_analyzer.ts` | Hurst Exponent via R/S analysis (rolling 256-bar window; shim at `analysis/trend_detection/hurst_analyzer.ts`) |
| `market_adapter/core/signals/permutation_entropy_analyzer.ts` | Permutation Entropy via ordinal pattern counting (shim at `analysis/trend_detection/permutation_entropy_analyzer.ts`) |
| `market_adapter/core/strategies/regime_gate.ts` | Bilinear regime multiplier (Hurst × PE lookup table) |
| `modules/constants.ts` (`MARKET_ADAPTER.HURST_CONFIG`, `PE_CONFIG`) | Shared Hurst + PE config (window sizes, scales) |
| `market_adapter/core/strategies/ama.ts` | Kaufman Adaptive Moving Average |
| `market_adapter/core/strategies/ama_slope_model.ts` | AMA slope weight computation |
| `analysis/price_sources.ts` | Unified candle data source abstraction |

## Runtime Notes

### Min-output threshold (`DYNAMIC_WEIGHT_ASYMMETRIC_TREND_THRESHOLD`, default 0)

After the final blended trend offset is computed, if `|finalOff| < minOutputThreshold` the trend component is suppressed and treated as `0`.
The symmetric volatility penalty is still applied independently. This means the bot can still receive a volatility-only weight adjustment even when the trend signal is below threshold. The payload flag `isReady` is only `false` when neither a trend offset nor a volatility penalty is active.

The research chart exposes this gate as the `th%` knob, so chart tuning and runtime overrides use the same threshold concept.

The runtime default is `0`, which disables the gate unless a market or bot override sets a higher threshold.

Can be overridden per-market or per-bot via `minOutputThreshold` in `marketAdapterSettings`.

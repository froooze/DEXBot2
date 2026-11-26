# DEXBot2 Tuning Cheat Sheet

This is a practical baseline for grid trading on DEXBot2.
It is based on the engine's actual grid math and reset flow, not a universal "best" config.

## Core rule

- Start from `targetSpreadPercent ≈ 4 x incrementPercent`.
- DEXBot2 enforces a minimum spread floor of about `2.1 x incrementPercent` and at least two spread slots, so the spread cannot be arbitrarily tight.
- The tighter the grid, the more liquid and stable the market must be.

## Structural vs Adaptive

Keep these structural settings static in normal operation:

- `incrementPercent`
- `targetSpreadPercent`
- `coreOrders`

These settings define ladder geometry and order-size distribution, so changing them is a retune, not a tactical response.

Use these adaptive settings for live trading behavior:

- `weightDistribution`
- `minPrice` / `maxPrice` ratio
- debt / collateral actions

That is the practical split:

- increment/spread define the grid
- AMA provides the anchor
- weights adapt to trend
- range ratio adapts slowly to former price action
- debt/collateral actions manage CR

## Quick ladder

| Regime | Increment | Spread | Open orders | Typical use |
|---|---:|---:|---:|---|
| Loose | `0.6%` | `2.4%` | `20 / 20` or lower if size gets too small | Conservative, noisy, thinner, or less mature markets |
| Basic | `0.5%` | `2.0%` | `20 / 20` | Safe default starting point |
| Competitive | `0.4%` | `1.6%` | `10-20 / 10-20` | Liquid enough for tighter quoting |
| Very competitive | `0.3%` | `1.2%` | `5-15 / 5-15` | Mature market, higher maintenance, lower slack |
| Aggressive | `0.2%` | `0.8%` | `3-10 / 3-10` | Only when liquidity, fees, and precision support it |

The main tradeoff is always the same:

- lower increment = tighter ladder, but more churn and smaller per-order sizes
- higher increment = wider ladder, less churn, but slower response and less quote quality

## What each setting means

### `incrementPercent`

This is the spacing between grid levels.

- lower values tighten the ladder
- higher values reduce churn and give the market more room to move
- if the pair is noisy or thin, do not force a tight increment

### `targetSpreadPercent`

This is the empty gap between the best buy and best sell rails.

- keep it as small as the market can tolerate
- `4x increment` is a healthy starting heuristic
- `3x` is a conservative default, not a universal optimum

### `weightDistribution`

This controls how size is distributed across the ladder.

- `0.5` is the neutral baseline; `1.0` is the shipped default (mountain)
- the scale runs from `-1` (super-valley) to `2` (super-mountain)
- values above `0.5` concentrate more size near the market-adjacent orders
- values below `0.5` flatten the ladder

Use weights to express inventory preference:

- mature, stable markets usually work best with flatter or near-neutral weights
- trending markets can justify stronger weighting if you want more size near the spread
- volatile markets usually prefer flatter weights so the bot does not over-commit near the edge
- lower volatility lets you increase weights and concentrate more funds near market-adjacent orders
- higher volatility argues for lower weights so more funds stay on the outer levels

In DEXBot2, buy-side allocation is reversed internally so the near-market buy orders also receive the larger share when weights are higher.

Negative weights are a special case:

- use slightly negative weights only when you intentionally want more size toward the outer ladder
- this makes sense in very volatile or mean-reverting markets where distant fills are realistic
- for most markets, lowering toward `0` is safer than going negative
- negative weights are not a default optimization; they are a deliberate fade/outer-liquidity choice

### `botFunds`

This is how much of each side's available balance gets committed.

- `100% / 100%` is aggressive
- leaving reserve gives you flexibility for fees, manual intervention, and regime changes
- if orders get too small, reduce commitment or reduce order count

### `coreOrders`

This is the number of live orders kept near the market on each side.

- more orders = smoother ladder, but smaller orders
- fewer orders = larger orders, but less depth
- `20 / 20` is a solid conservative baseline
- as increment tightens, you may need fewer orders unless capital is large enough to keep order sizes meaningful

### `minPrice` / `maxPrice`

These define the outer range of the grid.

- make the range only as wide as needed for the expected move until the next reset
- `3x` is a conservative default, not a target
- mature and frequently reset markets often do not need that much width
- wider ranges make sense only if the bot must survive larger drift between resets
- practical range bands:
  - below `2x` = very competitive
  - around `2x` = competitive
  - around `3x` = conservative
  - above `3x` = very conservative
- treat range ratio as a slow-moving setting driven by former price action, not a fast tactical knob
- use `dexbot tv <bot>` to see the grid range and AMA recentering against real candles before fixing the bounds

### `gridPrice`

This controls the reference price used when the grid is rebuilt.

- `null` uses the start price
- `ama` or `ama1`..`ama4` recenters on the adaptive moving average
- use AMA when the market drifts enough that a static center becomes stale

## Fund allocation logic

Use allocation settings to match market structure, not emotion.

- mature and liquid markets can support more aggressive deployment
- volatile or thin markets usually need more reserve and flatter allocation
- if you want stronger quoting near the spread, increase the weight
- if you want the ladder to feel smoother and less front-loaded, reduce the weight

The clean mental model is:

- `incrementPercent` controls spacing
- `targetSpreadPercent` controls the empty buffer
- `weightDistribution` controls size concentration
- `botFunds` controls risk budget
- `coreOrders` controls depth

## When to adjust

Adjust when the market changes enough that the current settings no longer make sense.

Examples:

- spreads are too tight and the bot churns
- spreads are too wide and the bot misses fills
- order sizes become dust-like
- too much capital sits idle
- the price center keeps drifting away from the grid
- the pair becomes more or less liquid than before

Do not tune on a fixed schedule. Tune when the bot's behavior stops matching the market.

## Resetting a grid

Use a clean-slate reset when you want the bot to rebuild around the current market without anchoring to the previous fill:

```bash
dexbot reset <bot>
```

That writes a recalculation trigger with `source: "manual_grid_full_reset"`, which also clears both last-fill guard references. The claw launcher reset and default settings patches that request a recalc write the same source (an explicit `source` or a null payload opts out). If the bot is running, it resets immediately; if it is stopped, it resets on the next start. A market-adapter trigger still performs a normal reset that keeps the guard.

Use a hard cleanup only when you want a full wipe of persisted order state.

## AMA in practice

AMA is the recentering mechanism.

- it is calculated from 1h candle closes
- it watches how far the adaptive center moves
- once the move crosses the configured threshold, DEXBot2 triggers a grid recalculation
- **AMA recentering requires whitelisting the bot for the market adapter to work live (otherwise it only logs).**
- `gridPrice: "ama"` tells the rebuilt grid to center itself on that AMA reference
- `gridPrice: "pool"` or `gridPrice: "book"` centers the rebuilt grid on the live pair price instead
- `gridPrice: null` falls back to the current `startPrice` reference

### `poolRef`

When using `startPrice: "pool"`, the bot discovers a pool matching your trading pair. If no such pool exists (e.g. a pair using a wrapped token without its own AMM pool), set `poolRef` to pin a proxy pool:

```json
"poolRef": "1.19.48"
```

The pool is fetched directly by ID (`get_objects`) — no discovery, no caching. Enter just the number (`"48"`) and the `1.19.` prefix is added automatically. Leave unset for normal discovery behavior.

Practical interpretation:

- if the market trends, AMA helps the bot stay centered
- if the market is choppy, a higher delta threshold reduces unnecessary resets
- if the market is moving and the bot lags, lower the threshold and recenter sooner

## Suggested operating defaults

For a conservative starting point:

- `incrementPercent: 0.5`
- `targetSpreadPercent: 2.0`
- `coreOrders: 20 / 20`
- `weightDistribution: 1.0 / 1.0` — the shipped default (mountain); flatten toward `0.5 / 0.5` only if you deliberately want a flatter ladder
- `minPrice` and `maxPrice`: as narrow as the expected drift allows, not blindly `3x`

For a more competitive market:

- `incrementPercent: 0.4`
- `targetSpreadPercent: 1.6`
- keep order sizes meaningful before increasing order count
- use weights only if you have a reason to prefer front-loaded inventory

For a very competitive market:

- `incrementPercent: 0.3`
- `targetSpreadPercent: 1.2`
- ensure liquidity is strong enough to justify the tighter ladder
- watch churn, fills, and dust closely

For an aggressive market:

- `incrementPercent: 0.2`
- `targetSpreadPercent: 0.8`
- only use this when the pair is liquid enough to support it
- reset discipline and fee control matter more at this level

## Bottom line

- tune for the market you actually have, not the market you wish you had
- tighter grids belong to more mature markets
- wider bounds are a safety margin, not a default optimum
- weights shape inventory behavior
- resets are for when the market regime has changed

# DEXBot2 vs. the Power-Law Liquidity Curve (CES)

> Proposal for a second liquidity protocol on BitShares that reproduces DEXBot2's
> **weight + range** fund allocation inside an AMM curve, instead of through an
> order book + active bot.

## Executive summary

**The unifying idea.** Every pool concept proposed in this paper shares one
property: a **higher fund allocation near the market price** than the existing
constant-product pool (`x·y = k`), whose capital density in log-price space
*grows with price* (`∝ e^(u/2)`) — thickest at high prices regardless of where
the market trades, and never concentrated around the market price (§2.1). Each
concept concentrates capital near the market in a different way, with different
knobs:

| # | Concept | Invariant | Concentration knob | Holdings split | Price range |
|---|---|---|---|---|---|
| — | Constant product (BitShares today) | `x·y = k` | none — capital density *grows* with price | fixed: 50:50 at **every** price | `(0, ∞)` |
| — | Weighted geometric mean (Balancer / Reciprocity-2 curve-only, §2.7 Q3) | `∏ x_i^{w_i} = k` (2-asset: `x^a·y^b = k`) | holdings `w` — skews density growth (`L ∝ e^(a·u)`), no interior peak | **free** (`w`, e.g. 80/20) at every price | `(0, ∞)` |
| 1 | CES, single exponent (§2.2) | `x^ρ + y^ρ = k` | shape `ρ` — one knob, both tails | fixed by price: 50:50 **only at `p = 1`**, drifts with `p` | `(0, ∞)` |
| 2 | CES, per-side exponents (§2.3) | `x^ρ_high + y^ρ_low = k` | shape `ρ_high`, `ρ_low` — one per tail | fixed by price: 50:50 point shifted off `p = 1` | `(0, ∞)` |
| 3 | Asymmetric Bounded (AB) pool (§2.5) | `(x+xv)^w · (y+yv)^(1-w) = k` | hard bounds `[P_low, P_high]` (the range); interior tilt via `w` | **free** (`w`, e.g. 80/20) | bounded, zero outside |
| — | StableSwap (companion doc, §2.6) | n-asset amplified invariant | `A` — flat region around the peg | balance-seeking (the peg) | `(0, ∞)` |

*"Fixed by price" means the LP cannot choose the split: at each price the
invariant dictates exactly which value split the pool holds (§2.2, holdings
note). Constant product is the special case where that dictation happens to
say 50:50 at every price; CES says 50:50 at only one price.*

**Bottom line.** DEXBot2 is an *active grid market maker* (discrete orders,
refill loop, signal-driven recentering, §1). The CES curves are *passive* but
concentrated invariants whose exponent `ρ` plays the same role as DEXBot2's
`weightDistribution`: the exponential decay rate of capital in log-price space.
The mapping `ρ = weight / (1 + weight)` is exact on the **high-price tail** of
the curve; the low-price tail decays at a *different* rate, and the grid's own
law is single-sided (sell sizes decay outward, buy sizes grow inward), so
reproducing it exactly needs a per-side exponent (§3). When the market price
moves, the pool's *active point* — the price it quotes — slides along the
curve automatically, but its capital *profile* (where the concentration hump
sits) is static: `ρ` and the peak it fixes stay put unless a keeper updates
them. A **dynamic `ρ`** that adapts to price deviations (§3.3) is the bridge
between the passive curve's capital efficiency and the bot's adaptivity.

**Two asymmetries, do not conflate them** (§2.7):

- **shape tilt (`ρ`)** — how fast liquidity *decays* per side away from the
  anchor (independently per side only in concept 2). The CES concepts (1, 2)
  have this knob — but it is shape only: the holdings split is fixed by the
  invariant at each price, not choosable.
- **holdings ratio (`w`)** — what value split the pool *holds* at the anchor
  (50:50 vs 80/20). The weighted cores have this knob — the Balancer /
  Reciprocity-2 baseline (unbounded) and the AB pool (concept 3, which adds
  hard bounds that cut tail waste to zero).

**Companion doc.** The pegged-pair half of the two-curve plan is StableSwap —
Curve's stable-swap invariant with amplification `A`, designed for BitShares in
[STABLESWAP-DESIGN](https://github.com/pi314x/bitshares-core/blob/stableswap/STABLESWAP-DESIGN.md).
It is the more general and more operationally complete *protocol* (n-asset
invariant, imbalanced-deposit and single-sided-withdrawal fees, explicit
rounding policy) and the preferred deployment for stablecoin pairs (§2.6, §7).
The CES curve is the more flexible *shape*: concentration around a *chosen*
anchor price, re-tunable by a keeper (dynamic `ρ`). This doc covers the
*volatile-pair* half.

### Contents

- §1 — Reference point: how DEXBot2 allocates funds today
- §2 — The pool concepts (all concentrating funds near the market)
  - §2.1 — The shared property: capital density in log-price space
  - §2.2 — Concept 1: CES, single exponent
  - §2.3 — Concept 2: CES, per-side exponents
  - §2.4 — Shared mechanics: the variable price and dynamic `ρ`
  - §2.5 — Concept 3: Asymmetric Bounded (AB) pool
  - §2.6 — Companion protocol: StableSwap (pegged pairs)
  - §2.7 — The landscape: symmetry × tail behaviour
- §3 — The mapping: DEXBot weight → curve exponent
- §4 — Side-by-side behavioural comparison
- §5 — Economics: fees, spread, impermanent loss
- §6 — Failure modes compared
- §7 — Recommendation: run both, or fuse
- §8 — Open questions / next steps

---

## 1. Reference point: how DEXBot2 allocates funds today

DEXBot2 is not an AMM. It is a bot that runs a **geometric price grid** of limit
orders against the existing BitShares order book:

| Parameter | Default | Meaning (from `modules/constants.ts`) |
|---|---|---|
| `incrementPercent` | 0.5 | Price step between grid levels, *geometric* spacing: `s = 1 + inc/100` |
| `targetSpreadPercent` | 2 | Width of the spread zone between best buy and best sell |
| `activeOrders` | `{sell: 20, buy: 20}` | Number of live orders kept on each side |
| `reserveOrders` | `{buy: 0, sell: 0}` | Edge-pinned live orders outside the window (dip/spike insurance, 0 disables per side) |
| `weightDistribution` | `{sell: 1, buy: 1}` | Geometric weight for order sizing |
| `botFunds` | — | Capital committed per side |
| `gridLimits` | — | Price bounds, min order size, dust threshold |
| AMA center price | — | The grid's anchor, from `market_adapter` (adaptive moving average) |

### Grid geometry
Levels are placed at

```
p_i = p_0 · (1 + inc/100)^i
```

so each level is the same *percentage* away from its neighbor — equal log-price
steps. A spread gap (`targetSpreadPercent`) is kept between the buy rail and the
sell rail; `calculateGapSlots` in `modules/order/grid.ts` converts that
percentage into the number of empty slots between the two rails.

### Order sizing (the weight axis)
`allocateFundsByWeights` in `modules/order/utils/math.ts` allocates the
per-side budget across `n` levels as:

```
rawWeights[i] = (1 - inc/100)^(i · weight)
sizes[i]      = rawWeights[i] / Σ rawWeights · totalFunds
```

- `weight = 0` → `rawWeights[i] = 1` → **uniform** allocation across all levels.
- `weight = 1` → full geometric decay: each level gets `(1 - inc/100)` of the
  previous level's weight.

Direction matters and is asymmetric by design:
- **SELL** (`reverse = false`): the level closest to the boundary gets the
  largest size; sizes decay going up.
- **BUY** (`reverse = true`): the level closest to the boundary gets the
  *smallest* size; sizes grow as you go deeper (buy more, cheaper).

These are *base-denominated* sizes. The two rails share the same `weight`
value (`{sell: 1, buy: 1}` by default); the asymmetry is a decay-**direction**
effect — sell sizes decay outward, buy sizes grow inward — not two different
decay rates. The CES comparison in §3 uses the quote-side density, which is a
different quantity (see §3.1).

### The dynamic behaviour DEXBot2 adds on top of the geometry
1. **AMA recentering** — the grid anchor `p_0` follows a signal (AMA, with
   Kalman velocity / Hurst / permutation-entropy regime inputs in the research
   tooling). When `p_0` moves past a threshold, a recalc trigger fires
   (`market_adapter/market_adapter.ts`).
2. **Dynamic weight offsets** — whitelisted bots get live-computed weight
   adjustments (`modules/dexbot_maintenance_runtime.ts`, weight-refresh
   block around the settings-merge code).
3. **Boundary crawl** — fills move the buy/sell boundary; the grid re-rolls
   roles and re-budgets (`modules/order/strategy.ts`, `calculateTargetGrid`).
4. **Refill loop** — filled orders are replaced on a refill interval, keeping
   the ladder alive (this is the "rebalancing" of a grid MM).
5. **Reconciliation** — startup grid reconcile + RMS-divergence-based recalc
   threshold (`calculateGridSideDivergenceMetric`, ~14.3% RMS default).

So DEXBot2 = **geometry (range) + per-level weighting (weight) + an active
control loop (recenter / refill / reconcile)**.

### What that means for capital allocation
In log-price space (`u = ln(p/p_0)`), the *base-denominated* order size per grid
level is

```
g(u) ∝ (1 - inc/100)^(i·weight),   i = u / ln(1 + inc/100)
     ≈ exp(-weight · u)            for small inc
```

a **single-sided** exponential in `u` — **not** symmetric around the AMA center:
- **sell rail** (`u > 0`): sizes decay going up, at rate `weight`;
- **buy rail** (`u < 0`): sizes *grow* going down, at rate `weight`
  (the `reverse` flag in `allocateFundsByWeights`).

`weight = 0` is the uniform limit. The *quote* commitment per level
(`size × price`, the quantity the AMM comparison in §3 cares about) is

```
q(u) = p(u)·g(u) ∝ exp((1 - weight)·u)
```

which is **uniform per level within each rail at the default `weight = 1`** —
the price exactly cancels the base-size growth. So DEXBot's default grid
deploys flat quote per level: in quote terms it is *less* concentrated than the
CES curve at `ρ = 0.5` (§3).

---

## 2. The pool concepts

Six pool concepts appear in this paper. Three are *proposed* here (CES
single-`ρ`, CES dual-`ρ`, AB pool); three are *reference points* (constant
product, weighted geometric mean, StableSwap). All of them except the two
product-family baselines (constant product, weighted geometric mean) share the
headline property —
they can *place* more capital near the market/anchor price than constant
product does — and differ in the knobs that produce it (§2.7 landscape).
One caveat runs through all of them: a passive pool's capital profile is
*fixed at creation* (absolute in price) and moves only when a keeper
re-parametrizes it, whereas the grid allocates *relative to a moving anchor*
(§2.4).

### 2.1 The shared property: capital density in log-price space

The right way to compare "how much fund sits near a given price" across pools
is the **marginal quote-reserve density in log-price space**:

```
L(u) = |dy/du|,     u = ln(p)
```

— quote reserves per unit of log-price. This is the passive-pool analogue of
the grid's per-level quote commitment `q(u)` (§1). Ranked by how much of that
density sits *near the market*:

| Pool | `L(u)` behaviour | Funds near the market? |
|---|---|---|
| Constant product (`x·y = k`) | `dy/du = y/2 ∝ e^(u/2)` — *grows* with price | **No** — no knob: density depends only on absolute price (thick above, thin below the current price), never on where the market is; sqrt-liquidity `√(xy)` is uniform in `u`, but quote-capital density grows |
| Weighted geometric mean (Balancer / Reciprocity-2 curve-only, §2.7 Q3) | `dy/du = a·y ∝ e^(a·u)`, `a = w_base/Σw` — *grows* with price at a skewed rate (CP is the `a = 0.5` case) | **No** — `w` skews which side is thicker but makes no peak; genesis `g_i` absorbs into `k`, so the shape is identical to Balancer |
| CES single-/dual-`ρ` (§2.2, §2.3) | peaks at a **fixed interior price set by `ρ`** (e.g. `p ≈ 2` at `ρ = 0.5` — *not* the current price), decays exponentially in **both** tails | **Yes — if deployed with the peak at the market**; one (or two) decay-rate knobs, but the profile is static (§2.4) |
| AB pool (§2.5) | weighted density inside `[P_low, P_high]`, **zero outside** | **Yes** — maximum concentration, hard-bounded |
| StableSwap (§2.6) | flat across the peg region, degrades toward constant product off-peg | Flat **by design** — for pairs whose price is *supposed* to sit still |

The constant-product baseline is the motivation for the whole paper: the
existing BitShares pool spreads its **sqrt-liquidity** `√(xy)` uniformly in
log-price space — but as a quote-capital density it actually *grows* with
price (`dy/du ∝ e^(u/2)`), so capital is neither concentrated around the
market nor balanced across prices. Every proposed concept below fixes exactly
that, at the cost of one or more extra parameters.

One structural difference to keep in mind throughout: a grid's allocation is
*relative* to its (moving) anchor `p_0` (`u = ln(p/p_0)`), so re-centering
moves the whole ladder. A passive pool's density profile is *absolute* in
price — fixed at creation, moving only when a keeper changes its parameters.
That asymmetry is why the re-centering comparison (§3.2, §4) and dynamic `ρ`
(§3.3) exist.

### 2.2 Concept 1: CES, single exponent

A two-asset AMM with the **constant-elasticity invariant**

```
x^ρ + y^ρ = k,      ρ ∈ (0, 1]
```

where `x`, `y` are the base/quote reserves and `k` scales total capital.

**Why this family.** It is the minimal one-parameter generalization of the
existing pool that keeps all the desirable AMM properties (convex invariant,
monotone price, infinite price range) while letting you *choose how tight the
capital is around a chosen anchor price* — `ρ` sets the tightness, the unit
normalization sets where (see the liquidity-distribution note below):

| `ρ` | Behaviour |
|---|---|
| `ρ → 0` | constant product `x·y = k` — uniform sqrt-liquidity `√(xy)` (the existing BitShares pool) |
| `0 < ρ < 1` | **concentrated** — liquidity peaks in the interior, decays in both tails |
| `ρ → 1` | constant sum `x + y = k` — all capital at a single price (degenerate) |

**Holdings note.** `ρ` controls **concentration near the market (shape)**,
not the **holdings split** — and the split is *not* "50:50 always", nor is it
a free parameter. At any price the invariant dictates exactly which value split
the pool holds, and deposits must follow the curve's current ratio. For
single-`ρ` that split passes through 50:50 exactly at `p = 1` and then drifts
deterministically with `p` (at `ρ = 0.5` the value ratio is `1/p` — a 2× price
rise leaves the pool holding 1:2 base:quote). Contrast constant product,
which holds 50:50 at **every** price: the CES split is balanced at one point
only, and *which* split it holds at other prices is not a knob. A pool that
*keeps* e.g. 80/20 value at the anchor needs the `w` knob of the AB pool
(concept 3, §2.5).

**Derived quantities.**

**Marginal price** (slope of the invariant):

```
p = (y / x)^(1 - ρ)
```

**Reserves as a function of price** (with `r = x/y = p^(1/(ρ-1))`):

```
y(p) = k^(1/ρ) · (1 + r^ρ)^(-1/ρ)
x(p) = r · y(p)
```

**Swap equation** — to buy `Δx` of base you pay `Δy` such that the invariant
holds:

```
x' = x - Δx
Δy = (k - (x')^ρ)^(1/ρ) - y
```

**Price range** — the curve spans **`(0, ∞)`**: as `x → 0` (pool is all quote),
`p → ∞`; as `y → 0`, `p → 0`. Unlike Uniswap V3, there is no `[P_low, P_high]`
truncation; the curve never "runs out" of one side.

**Liquidity distribution in log-price** — the density `L(u) = |dy/du|`
defined in §2.1 is, for CES,

```
L(u) ∝ r^ρ / ( (1 + r^ρ)^(1 + 1/ρ) · (1 - ρ) ),   r = x/y = p^(1/(ρ-1))
```

Unlike the grid's base-size law (single-sided `e^(-w·u)`, §1) or its flat
quote deployment at `w = 1`, this density peaks in the interior and decays in
**both** tails, at `r^ρ = ρ` (i.e. `r = ρ^(1/ρ)`, *not* at `r = 1`; for
`ρ = 0.5` the peak sits at `p ≈ 2`). **The peak is at a fixed price, not at
the market.** The profile `y(p)` is fully determined by `(k, ρ)`: `k` scales
its amplitude, `ρ` its shape, and nothing in the invariant references the
current market price — the hump sits wherever `ρ` (and the reserve-unit
normalization) puts it, and trading only slides the active point along it
(§2.4). Placing the peak *at* a chosen anchor therefore requires a unit
normalization — `(x/X0)^ρ + (y/Y0)^ρ = 1`, whose `X0`/`Y0` ratio shifts the
whole profile in log-price — exactly the scaling the AB v2 core carries
(§2.5); the bare `x^ρ + y^ρ = k` does not have it (§8). The two tails decay
exponentially at *different* rates:

| tail | decay rate | at `ρ = 0.5` |
|---|---|---|
| high price, `u → +∞` | `ρ/(1-ρ)` | `1` |
| low price, `u → -∞` | `1/(1-ρ)` | `2` |

So `ρ` is a single knob that sets the whole shape — but only one tail's decay
rate can match a given DEXBot `weight`; matching both sides requires a
per-side exponent (concept 2, next).

### 2.3 Concept 2: CES, per-side exponents

The single-`ρ` curve forces both tails to decay at rates coupled by one
parameter. Decoupling them needs two exponents:

```
x^ρ_high + y^ρ_low = k
```

The quote-liquidity still decays to zero in **both** tails — high-price rate
`ρ_high/(1-ρ_high)`, low-price rate `1/(1-ρ_low)` — for any
`ρ_high, ρ_low > 0`; a CES curve cannot make a tail *grow*. What two
exponents *can* do is set the two tail rates **independently**, which is the
curve-side expression of DEXBot's per-side intent (sell tight / buy deep) —
see §3.1 for the derivation and the DEXBot-side asymmetry it mirrors.

**Important limitation — shape only, not holdings.** Dual-`ρ` is **not** a
holdings-ratio knob. At any given price the reserve ratio is fixed by the
invariant: single-`ρ` is 50:50 only at `p = 1` and drifts with `p` (§2.2,
holdings note), dual-`ρ` holds one fixed ratio per price with the 50:50 point
shifted off `p = 1`. Neither
lets the pool *keep* e.g. 80/20 value at the anchor the way a weighted core
does — deposits must follow the curve's ratio, and price moves rebalance
along it (the split is a function of price, §2.2 holdings note, not a
knob). A free non-50:50 split needs the `w` knob of the AB pool (concept
3, §2.5).

### 2.4 Shared mechanics: the variable price and dynamic `ρ`

Both CES variants share two behaviours that are independent of which exponent
set is used.

**The variable price `p`.** The curve's marginal price `p = (y/x)^(1-ρ)` is
**not fixed at 1** — it is a function of the pool's current reserve ratio. At
perfect balance (`x = y`), `p = 1` regardless of `ρ`. But as the pool trades,
`x` and `y` shift and `p` slides along the invariant automatically:

- **Price drifts up** (`p > 1`): the pool sells base into the rising market,
  accumulating quote. The *active point* moves up the curve — the pool keeps
  quoting the new price with no intervention. (The density profile itself
  does not move; see the third bullet.)
- **Price drifts down** (`p < 1`): the pool buys base as the market falls,
  accumulating base. Again the active point slides; the profile stays.
- **Price moves significantly**: if the deviation is large enough that the
  concentrated region is no longer near the active price, liquidity thins out
  and slippage grows — the same trade-off a DEXBot grid faces when levels run
  dry.

For a **stablecoin pair** (`p ≈ 1` always), a high `ρ` (e.g. 0.95) keeps the
curve flat across the entire realistic price range — the StableSwap regime,
which the StableSwap protocol (§2.6) implements natively with amplification
`A`, no keeper required. For a **volatile pair** (`p` swings 2× or more), a
lower `ρ` (e.g. 0.5) spreads the concentration more thinly and extends the
tails to cover the wider range — note the hump itself sits at a fixed price
set by `ρ` (§2.2), not automatically at the current price.

**Why dynamic `ρ`.** A **fixed `ρ` is a bet on the market**: a flat
`ρ = 0.95` pool is optimal until the price moves 5%, then it's in the steep
part of the curve; a `ρ = 0.5` pool handles large moves but wastes capital
near the peg. This is where **dynamic `ρ`** enters — the keeper updates `ρ`
based on the same signal stack that currently drives the AMA, so the curve's
concentration always matches the market regime. The keeper logic, signal
mapping, and design questions are in §3.3 and §8.

### 2.5 Concept 3: Asymmetric Bounded (AB) pool

The recommended construction when the pool must express an **asymmetric fund
ratio** and waste **no capital in tails** — the only concept here with both
the holdings knob `w` and hard bounds. It is a Balancer-weighted core inside
a V3-style bounded range — one range per pool, closed-form swaps, no ticks,
no solver:

```
(x + xv)^w · (y + yv)^(1-w) = k,    w ∈ (0,1), w = weight of base
```

Real reserves `x` (base), `y` (quote); virtual offsets `xv, yv` shift the
curve so it hits the axes exactly at the bounds (`y = 0` at `P_high`,
`x = 0` at `P_low`). Outside `[P_low, P_high]` one reserve is zero and the
pool stops quoting that direction — **zero tail waste by construction**, and
therefore the strongest version of the "funds near the market" property: all
of the capital is inside the range by construction.

**Marginal price** (Balancer with virtual reserves):

```
p = (w/(1-w)) · (y + yv)/(x + xv)
```

**Parameters** per pool: `(w, P_low, P_high, fee)`.

- `w = 0.5` → symmetric (the §2.7 Q2 behaviour); `w = 0.8` → 80/20 base-heavy
  (4× more value in base at the anchor); `w = 0.2` → quote-heavy. Note that `w`
  weights the *virtual-inclusive* reserves `(x+xv)`, `(y+yv)`, so the
  real-reserve value split at the anchor tracks `w` but is skewed when the
  virtual offsets are large (narrow ranges) — flagged in §8.7.
- Swaps are Balancer math with `(x+xv)`, `(y+yv)` substituted — the same
  closed form as two already-deployed patterns combined. No Newton iteration
  (unlike StableSwap/CryptoSwap), no per-tick state (unlike full V3).

**Mapping from a DEXBot config** (making it a DEXBot-native pool, not a
generic Balancer clone):

| DEXBot concept | Pool parameter |
|---|---|
| `botFunds.sell / botFunds.buy` (capital per side) | `w = Vsell_value / (Vsell_value + Vbuy_value)` at `P0` |
| `gridLimits` (min/max price) | `[P_low, P_high]` — direct copy, tails cut exactly here |
| `activeOrders × incrementPercent` (range span) | range width when no explicit `gridLimits` (e.g. 20×0.5% ≈ ±10%) |
| `weightDistribution.sell / .buy` (decay tilt) | tilt *inside* the range (v2 `ρ`-tilt, below), or approximated by skewing `w` ±5–10% |
| AMA `p0` | anchor `P0` — set at creation, no keeper needed while price stays in range |
| `targetSpreadPercent` | fee rate: wider spread intent → higher fee |

**Worked examples.** Symmetric default grid (20+20 @0.5%, equal funds) →
`w=0.5`, `[P0·0.90, P0·1.10]` (concentrated CP, zero waste outside ±10%).
Asymmetric long-base book (80/20, buy-deep intent) → `w=0.8`,
`[P0·0.80, P0·1.05]` — tight upside, wider downside range, 4× base value at
anchor.

**Where the per-side `weight` tilt goes.** `w` is the fund *ratio* (value
split at anchor). The DEXBot decay *direction* (sell decays outward, buy
grows inward — the `reverse` flag in `allocateFundsByWeights`) is a second
knob: the v1 core above has a flat-ish density inside the range and does
*not* reproduce the buy-deep tilt (§3.1). The v2 upgrade replaces the
weighted-product core with the asymmetric CES core inside the same bounds:

```
((x+xv)/X0)^ρ_high + ((y+yv)/Y0)^ρ_low = 1     ← v2, custom invariant
```

with `ρ_high = w_sell/(1+w_sell)` (§3 mapping). That adds tilt at the cost of
a custom solver — ship v1 first, add v2 only if backtests on Kibana fill
data show the flat-inside-range density underperforms the grid shape on fee
capture.

**Tradeoff vs CES/StableSwap:** bounded means someone re-anchors when the
market leaves the range (pool goes single-sided, stops quoting one
direction). That is the same maintenance a grid has when levels run dry —
except one range move instead of N order replaces + reconcile. The
`market_adapter` signal stack (AMA anchor, ATR width, trend skew,
readiness/staleness gates) is the keeper for exactly this (see §7 fusion
option).

### 2.6 Companion protocol: StableSwap (pegged pairs)

The StableSwap design
([STABLESWAP-DESIGN](https://github.com/pi314x/bitshares-core/blob/stableswap/STABLESWAP-DESIGN.md))
is a second curve designed for BitShares, aimed at *pegged* pairs. Its
amplification coefficient `A` walks the same interpolation axis as `ρ`
(`A → 0` → constant product, `A → ∞` → constant sum), but the protocol around
it is more general and more operationally complete than the bare CES
invariant proposed here:

- the invariant is defined for `n` assets, with `D` replacing `k` as the stored quantity;
- imbalanced deposits and single-sided withdrawals are explicitly priced and fee'd;
- the rounding rules are fully specified and fuzz-tested;
- `A` has a policy path (Curve ramps it over time), whereas dynamic `ρ` here is still an open question (§8).

Note the direction of each claim: the StableSwap *protocol* is the more
finished design, but the CES *curve* is the more flexible *shape*. Only CES
has a *movable* concentration anchor — a keeper can re-tune `ρ` (and the
per-side exponents) to re-concentrate toward the market; StableSwap's `A` only
controls how long the flat region survives imbalance, and is fixed at pool
creation. Which one is "more flexible" depends on whether you mean the
protocol or the shape.

The two curves are complements, not competitors — they answer different questions:

| | CES (this doc) | StableSwap |
|---|---|---|
| Answers | *where is the market price?* | *is the price even supposed to move?* |
| Intended pair | volatile — price free to move | pegged — both assets meant to hold the same value |
| Knob | `ρ` ∈ (0, 1] | `A` > 0 |
| Knob interpolates | constant product (`ρ → 0`) ↔ constant sum (`ρ → 1`) | constant product (`A → 0`) ↔ constant sum (`A → ∞`) |
| Anchor of capital | a **fixed peak placed at creation** (price set by `ρ` + unit normalization, §2.2); the *active point* slides with reserves, but the hump moves only when a keeper re-tunes `ρ` | **balance (the peg)** — flatness is a property of the pair, not of the market |
| Off-anchor behaviour | tails decay exponentially with price deviation — *thinner than constant product* far off-anchor | degrades *toward constant product* — flat region holds to roughly 80–90% imbalance, then falls back to the existing pool's curve |
| Adaptation | optional dynamic `ρ` keeper tracking the market regime | none needed — the peg defines the anchor (Curve ramps `A` only for re-tuning) |

**Why a stablecoin pair should not use high-`ρ` CES.** This is the one regime
where CES cannot simply *replace* the dedicated protocol, and the reason is
the off-anchor tail behaviour: StableSwap degrades toward constant product
when the pool becomes lopsided, so its liquidity floor is the existing pool's
curve; a high-`ρ` CES curve's tails decay exponentially — *thinner than
constant product* at exactly the price deviations a depeg produces, when
depth is needed most. Recovering that floor dynamically means a keeper
lowering `ρ` on deviation (§3.3), which is an open design problem (§8);
StableSwap gets the graceful degradation for free, from the invariant itself.
The CES curve is the *complement*: concentration for volatile pairs, where
StableSwap's flat region would be wasted capital — and for almost-stable
pairs that drift and re-anchor, dynamic `ρ` offers an adaptability that
StableSwap's creation-fixed `A` does not.

### 2.7 The landscape: symmetry × tail behaviour

Every pool curve in scope — the concepts in this doc plus the candidates from
the survey — lands in one quadrant of this matrix. Two axes: symmetry and
tail behaviour. But "asymmetric" covers **two different knobs** — do not
conflate them:

- **holdings ratio `w`** — what value split the pool *holds* at the anchor
  (50/50 vs 80/20). Only weighted cores (Balancer, AB pool) have this knob.
- **shape tilt `ρ`** — how fast liquidity *decays* per side away from the
  anchor. CES single-/dual-`ρ` has this knob.

CES dual-`ρ` gives shape tilt only — it cannot *choose* its value split: the
split is a fixed function of price (with the 50:50 point shifted off `p = 1`),
not a knob (§2.3). The AB pool is the only option in this doc with both knobs.

| | tail (infinite range `(0, ∞)`) | no-tail (bounded `[P_low, P_high]`, zero outside) |
|---|---|---|
| **symmetric holdings + shape** | **Q1:** constant product `x·y=k` (BitShares today); CES single-`ρ` `x^ρ+y^ρ=k` (§2.2); StableSwap (balanced, flat near peg) | **Q2:** Uniswap V3 single symmetric range; bounded-weighted `w=0.5`; bounded CES single-`ρ` truncated to bounds |
| **asymmetric holdings (`w`) and/or shape (`ρ`)** — knobs per entry, see legend | **Q3:** Balancer Weighted [holdings `w`] `∏x_i^w_i=k` (80/20…); CES dual-`ρ` [shape only, split fixed by price] `x^ρh+y^ρl=k` (§2.3); LBP [holdings `w(t)`]; DODO PMM [oracle anchor + shape `k`, single-sided OK]; Curve CryptoSwap [auto shape] | **Q4:** **AB pool** [holdings `w` + bounds] `(x+xv)^w·(y+yv)^(1-w)=k` (§2.5); bounded asymmetric CES v2 [holdings-scale + shape] `((x+xv)/X0)^ρh+((y+yv)/Y0)^ρl=1`; V3 asymmetric position / Bancor Carbon [per-position shape, single-sided] |

Reading rule: **left → right** is efficiency (cut the tails, but accept a
re-anchor when price exits the range — the passive-pool analogue of a grid
running dry). **Top → bottom** is expressiveness (one shape for both sides vs
independent per-side control, at the cost of more params and audit surface).
Q2/Q4 are the efficient versions of Q1/Q3 with the same symmetry. The
recommended asymmetric + no-tail pool is the AB pool — **Q4**, first row of
the bottom-right quadrant.

---

## 3. The mapping: DEXBot weight → curve exponent

DEXBot's `weight` (a decay *rate* — not to be confused with pool holdings
`w`, the value split) and the curve's `ρ` are the same *kind* of quantity —
an exponential decay rate in log-price space — but they are rates of
*different measures*: the grid's base sizes `g(u)` and the curve's quote
density `L(u)`.
DEXBot's *base-size* law is **single-sided** (`rawWeights[i] = (1-inc)^(i·weight)`:
sell sizes decay going up, buy sizes grow going down), and its *quote*
deployment `q(u) ∝ e^((1-w)·u)` is flat at the default `w = 1`. The CES quote
density instead peaks in the interior and decays in **both** tails:

| | Shape in log-price space |
|---|---|
| DEXBot2 base sizes `g(u)` | single-sided `e^(-w·u)` — sell decays, buy grows |
| DEXBot2 quote `q(u)` | `e^((1-w)·u)` — uniform per level at `w = 1` |
| CES high-price tail | `ρ/(1-ρ)` (decays) |
| CES low-price tail | `1/(1-ρ)` (decays) |

Setting the grid's sell-rail decay rate `weight` equal to the curve's
high-price tail:

```
ρ / (1 - ρ) = weight   →   ρ = weight / (1 + weight)
```

Note the cross-measure in this match: it equates the grid's *base*-size
decay — the quantity `weightDistribution` actually controls — with the
curve's *quote*-density tail decay. Matching the grid's own *quote*
deployment instead would set `ρ/(1-ρ) = weight − 1`, meaningful only for
`weight > 1`; the default grid's flat quote per level has no CES tail-rate
counterpart (§1). The low-price tail then decays at `1/(1-ρ) = weight + 1` — at the default
`weight = 1` (`ρ = 0.5`) the curve decays at rate `1` above the anchor and
`2` below it. So the single-exponent mapping **only matches the high side**:

| DEXBot2 `weight` | Curve `ρ` (high tail) | Low-tail rate `1/(1-ρ)` |
|---|---|---|
| 0 | 0 | 1 (uniform) |
| 0.5 | 0.333 | 1.5 |
| 1 | **0.5** | **2** |

So **DEXBot2's default `weight = 1` maps to `ρ = 0.5` on the curve's high
side** — a *sell-side / high-price* equivalence. The two systems share an
allocation philosophy but differ in shape:

- DEXBot2: base sizes single-sided (`e^(-w·u)`), quote flat at `w = 1`.
- Curve: quote density decays in both tails, with asymmetric rates.
- Matching the grid on both sides needs per-side exponents — and even then the
  curve can't reproduce the buy rail's *growing* sizes (§3.1).

### 3.1 Per-side asymmetry — and what the curve cannot reproduce

DEXBot2's *base-denominated* sizes differ by side: the buy rail grows with
depth, the sell rail decays outward (the `reverse` flag in
`allocateFundsByWeights`) — with the default weights themselves symmetric at
`{sell: 1, buy: 1}`. The asymmetry is a decay-**direction** effect, not a
difference in the two weight values.

A CES curve cannot make a tail *grow*: even with two exponents (concept 2,
§2.3), the quote-liquidity decays to zero in **both** tails for any
`ρ_high, ρ_low > 0`. What two exponents *can* do is set the two tail rates
independently. (Naming is by tail, not by weight: `ρ_high` sits on the base
reserve `x` and is derived from the *sell* weight, because the sell rail lives
above the anchor; `ρ_low` sits on the quote reserve `y` and comes from the
*buy* weight.)

```
ρ_high = w_sell / (1 + w_sell)   (high-price tail rate = w_sell)
ρ_low  = 1 - 1 / w_buy           (low-price tail rate = w_buy)
```

Note the boundary case: matching the low tail to the default `w_buy = 1` would
require `ρ_low = 0`, which degenerates the invariant (`y^ρ_low → 1` drops the
quote term, leaving the quote side unconstrained). So an exact two-exponent
match of the symmetric default is not available — `ρ_high = 0.5` matches the
high tail, and the low tail can only approach rate `1` from above. The
exponent pair is really a way to bias the pool *toward* one side (e.g.
`w_buy = 2, w_sell = 1` gives `ρ_high = 0.5`, `ρ_low = 0.5`), mirroring the
grid's decay *directions* rather than its exact quote density.

### 3.2 Center / range equivalence

| DEXBot2 concept | Curve equivalent |
|---|---|
| AMA center `p_0` | the curve's *density peak* — fixed at creation by `ρ` + unit normalization (§2.2); the *active point* slides automatically, but the peak does not — matching the grid's re-centering needs dynamic `ρ` (§3.3) |
| `activeOrders × incrementPercent` (range span) | width of the concentrated region, set by `ρ` |
| `weightDistribution` (decay rate) | `ρ` (per side) — **shape only** (tail decay rates), split fixed by price |
| `botFunds` sell/buy split (holdings ratio) | **no CES equivalent** — the split is fixed by price (single-`ρ`: 50:50 only at `p = 1`, drifts with `p`; dual-`ρ`: one fixed ratio per price); a free split needs the AB pool's `w` (§2.5) |
| `targetSpreadPercent` | implicit — effective spread is *tightest* near the liquidity peak (`r^ρ = ρ`) and widens toward the tails |
| refill loop | none needed — liquidity is continuous, always in the market |
| boundary crawl / reconcile | none needed — price just moves the active point along the curve |
| dynamic weight offsets | static `ρ` or time-varying `ρ(t)` driven by the same signals |

### 3.3 Dynamic `ρ`: adapting concentration to price

When the market price `p` deviates from the pool's anchor, a **fixed** `ρ`
creates a mismatch — the concentrated region is no longer where the price
is, and liquidity thins in the wrong place (§2.4). Dynamic `ρ` solves this:

| Market condition | Price deviation | `ρ` | Effect |
|---|---|---|---|
| Pegged / flat | `\|p - 1\| < 2%` | 0.90–0.95 | Wide flat region around the peg/anchor, StableSwap-like |
| Mild drift | `2%–10%` | 0.7–0.85 | Moderate concentration, curve extends to cover drift |
| Trending regime | `>10%` or Hurst > 0.5 | 0.5–0.6 | Concentrated but tails extend to follow the trend |
| Depeg risk | Large deviation + regime shift | 0.3–0.45 | Maximum tail spread, pool won't run dry |

One subtlety: `ρ` sets both the shape *and* the hump's location (§2.2) —
lowering `ρ` extends the tails but simultaneously moves the peak's price
(e.g. `ρ = 0.95` → hump near `p ≈ 1.00`, `ρ = 0.55` → hump near `p ≈ 1.63`).
The keeper's `ρ` rule and the peak-placement question must therefore be
designed together (§8, item 8).

The keeper computes `ρ` from the same signals that currently drive the AMA
(ATR for deviation magnitude, Kalman velocity for trend speed, Hurst/PE
for regime classification):

```
p_deviation = |p_market - p_pool| / p_pool
if p_deviation < 0.02:        ρ = 0.95   // flat near peg
else if p_deviation > 0.10 && Hurst > 0.5:
                              ρ = 0.40   // depeg risk: max tail spread
else if p_deviation > 0.10 || Hurst > 0.5:
                              ρ = 0.55   // trending regime, extend tails
else:                         ρ = 0.70   // default
```

This is the **fusion option** from §7 — the DEXBot2 brain pointed at the curve
instead of the book. The keeper is not a new process; it is the existing
signal stack with one additional output.

---

## 4. Side-by-side behavioural comparison

| Aspect | DEXBot2 (grid + bot) | CES curve (passive, Q1/Q3) | AB pool (bounded, Q2/Q4) |
|---|---|---|---|
| **Mechanism** | discrete limit orders on the book | continuous invariant | continuous invariant with virtual offsets |
| **Capital placement** | N levels × weight, per side | smooth density `L(u)`, exponent `ρ` | weighted density inside `[P_low, P_high]`, **zero outside** |
| **Holdings split** | free (`botFunds` per side) | not free — fixed by price (50:50 only at `p = 1`; fixed-per-price for dual-`ρ`) | free (`w`, e.g. 80/20) |
| **Range** | bounded by grid + `gridLimits` | infinite `(0, ∞)` | bounded `[P_low, P_high]`; single-sided outside |
| **Recenter on market move** | AMA trigger → recalc → cancel/replace orders | *quoted price* follows automatically (active point slides, no tx) — but the capital profile does **not** re-concentrate; that needs dynamic `ρ` (§3.3) | keeper re-anchor tx (`market_adapter`) when price exits or deviates past threshold |
| **Fill behaviour** | discrete fills at fixed prices; gap risk between levels | every price is quoted continuously; no gaps | continuous inside range; no quotes outside (hard gap by design) |
| **Refill** | required (refill interval) | not required | none inside range; re-anchor when out of range |
| **Maintenance** | reconcile, RMS divergence, COW snapshots | none on-chain | re-anchor txs only, no per-order churn |
| **Gas / ops cost** | per-order placements, cancels, refills, recalcs | one deposit, then trades only | one deposit + occasional re-anchors |
| **Latency/MEV surface** | order book exposure, stale quotes between refreshes | no stale quotes; slippage always visible in the curve | no stale quotes inside range; edge latency when the market crosses a bound |
| **Adaptivity** | rich: AMA, Kalman/Hurst/PE regime, dynamic weight, asymmetric bounds | static `ρ`, or dynamic `ρ(t)` updated by a keeper from the same signal stack | `w`/bounds via keeper (AMA anchor, ATR width, trend skew) |
| **Who controls it** | bot process (needs to run, watch, reconnect) | the curve (liquidity providers just deposit) | the curve inside the range; the keeper owns the range |
| **Revenue model** | spread capture from order fills | fee on every swap (proportional to activity) | fee on every swap, concentrated inside the range |

### Where DEXBot2 wins
1. **Adaptivity** — the signal stack (AMA center, dynamic weight, regime
    detection) changes *where and how much* capital sits in the market. A
    passive curve with static `ρ` needs a keeper to update it to do any of
    that — but with **dynamic `ρ`**, the same signal stack drives the curve,
    and this gap closes.
2. **Asymmetric, intent-driven sizing** — buying more cheaply deep while selling
    the most near price is a *strategy*; the curve only expresses it as static
    `ρ_high/ρ_low`.
3. **Granular control of spread** — `targetSpreadPercent` and `gridLimits` give
    exact, per-level control that a single exponent can only approximate.

### Where the curve wins
1. **Zero gaps / always in the market** — a grid leaves price ranges with no
   order (every empty slot = a gap where the bot earns nothing and absorbs
   nothing). The curve quotes *every* price between `0` and `∞`.
2. **No refill/reconcile machinery** — no interval-based re-placement, no
   startup reconciliation, no COW snapshots. The protocol can't "fall behind"
   the market.
3. **Deterministic and atomic** — one deposit commits the whole strategy;
   nothing depends on a bot process staying alive or a node staying connected.
4. **Capital efficiency is a property, not an activity** — concentration is
   baked into `ρ`; it never degrades because a refill was missed or a recalc
   threshold wasn't crossed.

---

## 5. Economics: fees, spread, impermanent loss

**DEXBot2** earns *spread*: it buys at `bid` and sells at `ask`, capturing the
difference on each round trip, minus fees. Its capital efficiency is limited by
grid spacing — during a move, levels fill sequentially, so only the filled
levels earn.

**CES curve** earns *fees per swap* (like every AMM) and benefits from the same
"buy low / sell high" round trip via the concentrated region: as price drifts
down, the pool rebalances toward base (buying); drifting up, toward quote
(selling) — the same inventory swing a grid MM executes, but continuously and
in one curve instead of N orders.

**Impermanent loss:** both systems are subject to it on directional moves — and
*concentration makes IL worse, not better*. For the same nominal capital,
`ρ = 0.5` has roughly **twice** constant product's IL: at a 2× move `−11.1%`
vs `−5.7%`, at a 5× move `−44.4%` vs `−25.5%`. (IL percentages are invariant to
capital scale, so "behaves like a smaller constant-product pool" is not a valid
intuition — the concentrated region is *more* sensitive per unit of capital,
which is the flip side of capturing more fees per swap.) `ρ` is the dial
between fee capture and IL exposure; `ρ → 0` recovers the pure constant-product
IL profile. This is the same trade a tight DEXBot grid makes: narrower spacing
earns more per round trip but swings inventory harder per unit of price move.
The AB pool concentrates further (bounded + weighted): higher fee capture
inside the range and higher IL per unit move inside it, but zero exposure
outside — when out of range it sits single-sided instead of tracking the
market the way CES tails do.

The two systems are *related*, not identical: **a CES pool is the continuous
limit of a DEXBot grid whose order count → ∞ and whose spacing → 0 only on the
high-price tail** — the grid's single-sided base-size law (and its flat quote
deployment at `w = 1`) does not equal the curve's decaying `L(u)` (see §3).
Per-side exponents close most of the gap; the residual difference is that
DEXBot re-centers and re-weights *over time*, while the curve's shape is fixed
until a keeper updates it. It is not "duct taped" V3 — it is DEXBot's weighting
law, *one side at a time*, written as an invariant.

---

## 6. Failure modes compared

| Failure | DEXBot2 | CES curve | AB pool |
|---|---|---|---|
| Bot/node down | orders stale, refills stop, grid freezes | protocol keeps working; liquidity always live | protocol keeps working inside range; out-of-range positions sit single-sided until re-anchored |
| Reconnect / resync | reconcile errors, RMS divergence recalcs | nothing to resync | nothing to resync (range state is explicit on-chain) |
| Fill gap risk | empty slots between levels | none | none inside range; hard gap outside range by design |
| Impersonation / malicious quote | possible around stale orders | no — price is always the curve's slope | no inside range — same slope pricing |
| Parameter drift | config merge + dynamic weights can drift silently | one constant `ρ`, auditable in one line | `(w, P_low, P_high, fee)` per pool, auditable in one line |
| Concentration too tight | grid too tight → lots of churn, fees dominate | `ρ` too high → fee income can't beat IL | range too tight → exits often, re-anchor churn dominates |

---

## 7. Recommendation: run both, or fuse

Per concept, in deployment-priority order:

- Keep **DEXBot2** where adaptivity pays: volatile pairs, regime shifts, and
  when you want per-side intent (buy deep / sell tight).
- Deploy the **CES pool** (concept 1/2, §2.2–§2.3) where you want the passive
  guarantee: always-quoted, gap-free, zero-maintenance concentration. Start
  from `ρ = 0.5` (the weight=1 equivalent on the high side; the low side then
  behaves like `weight = 2`), and re-tune per side if you want the grid's exact
  *shape* (shape only — the split is fixed by price, not choosable; for a
  different split see the AB pool bullet).
- **For stablecoin pairs**: prefer the **StableSwap pool** (§2.6,
  [STABLESWAP-DESIGN](https://github.com/pi314x/bitshares-core/blob/stableswap/STABLESWAP-DESIGN.md)) —
  its amplification `A` gives the same flat-near-peg behaviour (near-zero
  slippage across the realistic range), and on a depeg it degrades *toward*
  constant product — a liquidity floor — while a high-`ρ` CES curve thins
  *below* constant product exactly when depth is needed (§2.6). Its protocol is
  also more general and more operationally complete: n-asset invariant,
  imbalance and single-sided-withdrawal fees, no keeper required. A high
  fixed `ρ` (0.90–0.95) CES pool is the fallback where StableSwap is not
  available.
- **For volatile / almost-stable pairs**: deploy CES with **dynamic `ρ`**
  (§3.3) — the keeper updates the exponent from the same signal stack (AMA,
  ATR, Kalman velocity, Hurst/PE regime) that the bot already computes. When
  the price is flat, `ρ` stays high (flat near peg); when the market moves,
  `ρ` drops and the curve widens its concentration for the wider range
  (remember the hump shifts with `ρ` — §3.3). This is the
  CES analogue of Curve's ramped `A` — in the StableSwap design `A` is fixed
  at creation, and changing it is listed as unsettled.
- **For asymmetric books with no tail waste (Q4):** deploy the **AB pool**
  (§2.5) — `(w, P_low, P_high, fee)`, single range, closed-form swaps. `w`
  from `botFunds` ratio, bounds from `gridLimits` (or
  `activeOrders × incrementPercent`), anchor `P0` from AMA. The v2
  `ρ_high/ρ_low` tilt inside the bounds is the upgrade path if backtests
  justify the custom invariant.
- **Fusion option:** a keeper that updates `ρ_high`/`ρ_low` from the same
  signal stack (`AMA`, `ATR`, Kalman velocity, Hurst/PE regime) that the bot
  already computes. That keeper is *exactly* the DEXBot2 brain pointed at the
  curve instead of the book — the "second protocol" then shares both the
  allocation law *and* the adaptivity.

---

## 8. Open questions / next steps

1. **Exact `ρ` calibration** — verify the *high-tail* mapping
    `ρ = weight/(1+weight)` against backtests. The low tail has no direct grid
    counterpart at `ρ = 0.5` (rate 2; the default grid is flat in quote terms on
    both rails), so calibrate it from desired downside behavior and the
    ~`1:2 center/outer split` comment in `modules/constants.ts`.
2. **Asymmetric `ρ_high`, `ρ_low`** — derive the per-side exponents from the
    curve's verified tail rates (`ρ_high = w_sell/(1+w_sell)`,
    `ρ_low = 1 - 1/w_buy`) and quantify the DEXBot-side decay *directions* from
    `allocateFundsByWeights`'s `reverse` flag, which are the actual asymmetry
    (the default weights are symmetric `{sell: 1, buy: 1}`).
3. **Dynamic `ρ`** — which of the market-adapter signals should re-parametrize
    the curve, and on what cadence (avoid turning a passive protocol into a
    churn machine). Key design decisions:
    - **Deviation threshold**: at what `|p_market - p_pool|` does `ρ` start
      updating? Too sensitive → churn; too insensitive → liquidity thins
      before the keeper reacts.
    - **Smoothing**: should `ρ` update immediately or with a moving average
      to avoid oscillation around thresholds?
    - **Bounds**: what are the min/max `ρ` values? `ρ_min` protects against
      pool-dry on extreme moves; `ρ_max` preserves the flat-region benefit
      for stable pairs.
    - **On-chain vs off-chain**: does the keeper submit `ρ` as a tx (one
      operation per update), or is `ρ` embedded in the pool's state
      machine updated by any participant?
4. **Variable `p` on-chain**: the pool must expose its current price
    (single-`ρ`: `p = (y/x)^(1-ρ)`; dual-`ρ`:
    `p = (ρ_high/ρ_low) · x^(ρ_high-1) · y^(1-ρ_low)`) so the keeper can
    compute deviations without syncing reserves externally. Is this a new operation, a view function, or
    derived from the pool's stored `D` and reserve ratio?
5. **Fees** — set fee rate so it clears the IL cost of the concentrated region;
    this is the single most important tuning knob. Dynamic `ρ` adds another
    dimension — fees must cover IL across the full range of `ρ` values, not
    just one.
6. **On-chain deployment shape** — single deposit with `ρ` frozen, or a
    rate-limit-reweightable pool where the keeper can update `ρ` within
    bounds without a full pool migration.
7. **AB pool calibration** — validate the `botFunds` → `w` mapping against
    backtests (does an 80/20 book earn its IL?); audit the `xv`/`yv`
    derivation for edge bounds (`P_low → 0`, dust reserves); choose the ATR
    width multiplier `k` and `minScaleSlots` floor so re-anchors stay rarer
    than grid recalcs; set re-anchor cadence (deviation threshold + cooldown)
    and the on-chain `update_pool_params` op with `w`/range bounds checks.
8. **Peak placement / unit normalization** — the bare invariant pins the
    density hump at `p = ρ^(1-1/ρ)` (e.g. `p ≈ 2` at `ρ = 0.5`), independent
    of deposit size: `k` scales the profile's amplitude, not its location
    (§2.2). A deployable pool needs an `X0`/`Y0` normalization —
    `(x/X0)^ρ + (y/Y0)^ρ = 1` — to place the peak at the market anchor; the
    AB v2 core already carries it (§2.5). Decide whether concepts 1/2 ship
    normalized or bare, and note that dynamic `ρ` re-places the hump while
    re-shaping it (§3.3): a keeper that only thinks in tail-rates will move
    the peak unintentionally.

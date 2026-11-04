# DEXBot2 /scripts CLI Documentation

This guide provides a terminal-focused reference for the maintenance and diagnostic utilities available in the `scripts/` directory.

Every command that writes a file prints the same trailer
(`[Tag] ✓ <kind> saved. Open <kind>: (file://…)`) plus the shared section/warning/summary
blocks, all from `modules/cli_progress.ts` (`savedLine`, `section`, `warningsBlock`, `summaryLine`).

Asset symbols are case-insensitive wherever a command takes one (`dexbot asset token.sym`,
`dexbot rich token.sym`, `dexbot liq A/B`, `dexbot tv <pool-token>`, `--base`/`--quote`): every
path resolves through `modules/asset_lookup.ts`, which looks the symbol up in its canonical UPPERCASE
form and keeps `1.3.x` ids untouched.

---

## 🛠️ CORE MAINTENANCE

### Update DEXBot2
**File:** `update.ts` (shim: `update.js`), install-layout detection in `update_layout.ts`
**Purpose:** Perform a safe, production-ready update.
```bash
# Pull latest code, install deps, and restart PM2
dexbot update
```
*Note: Protects your `profiles/` directory during the update process.*

---

## 🧹 CLEANING & RESET (DANGER ZONE)

All clear/reset scripts resolve paths through `scripts/lib/dexbot-paths.sh`
(mirrors `modules/paths.ts`). Env overrides: `DEXBOT_PROFILE_ROOT`,
`DEXBOT_MARKET_ADAPTER_DATA_DIR`, `DEXBOT_MARKET_ADAPTER_STATE_DIR`,
`DEXBOT_CLAW_DATA_DIR`; the `dexbot` CLI passes the resolved dirs automatically.

| Install | Profile root | Market adapter data/state | Claw data |
|---------|--------------|---------------------------|-----------|
| Source checkout | `<repo>/profiles` | `<repo>/market_adapter/{data,state}` | `<repo>/claw/data` |
| Global npm (`npm i -g dexbot`) | `~/.config/dexbot2/profiles` | `<profiles>/market_adapter/{data,state}` | `<profiles>/claw/data` |

Shared behavior:
- **Advisory live-runtime warning.** Before the prompt the scripts check runtime
  PIDs and this install's online PM2 apps. A live bot re-persists its grid and a
  live adapter can recreate its state/lock, so stop first with `dexbot stop`.
  The warning never blocks the deletion or changes the exit code.
- **One log predicate** (`*.log`, rotated `*.log.*`, `*.jsonl*`) so preview,
  count, delete and verify always agree. It also removes the credential audit
  trail `daemon-audit.jsonl*`, which is named in the preview.

| Script | Deletes |
|:---|:---|
| `clear-logs.sh` | `<profiles>/logs/*.{log,jsonl}`, including market adapter logs and `daemon-audit.jsonl*` |
| `clear-orders.sh` | `<profiles>/orders/*` |
| `clear-market-adapter.sh` | market adapter `data/`, `state/`, and its runtime logs |
| `clear-all.sh` | orders + logs + market adapter data/state + claw data |
| `reset-settings.sh` | general, market and market-adapter settings files (defaults restored next run) |

All are irreversible and prompt for confirmation.

---

## 📊 DIAGNOSTICS & VALIDATION

### Grid Order Analysis
**File:** `analyze-orders.ts` (CLI: `dexbot order`)
**Purpose:** Analyze grid order metrics and order distribution patterns.
```bash
# Analyzes spread accuracy, geometric consistency, and fund distribution
node dist/scripts/analyze-orders.js

# One bot (name or key), or every grid on one account (name or 1.2.x id)
node dist/scripts/analyze-orders.js <bot|account>
```

Bot/account targets share one rule set with `dexbot credit`, `dexbot pnl` and
the chart commands (`analysis/bot_key_utils.ts`).

For AMA bots (`gridPrice: ama`) the analyzer reads `<botKey>.dynamicgrid.json`
and, when fresh (`2 × MARKET_ADAPTER.RUNTIME_DEFAULTS.pollSeconds`, default 2h),
shows live weights with color: higher = red (losing), lower = green (winning),
static = grey. Stale snapshot appends a red `(adapter offline)` alert to the
static weights.

### Credit Analysis
**File:** `analyze-credit.ts` (CLI: `dexbot credit`)
**Purpose:** Live-chain overview of active MPA (margin) and credit (borrowed-deal) positions, summed per asset per bot — the credit counterpart to `analyze-orders.ts` / `dexbot order`.
```bash
# Credit-enabled bots only
node dist/scripts/analyze-credit.js

# Single bot (name or key)
node dist/scripts/analyze-credit.js <bot>

# Every bot trading one account (preferredAccount name or 1.2.x id)
node dist/scripts/analyze-credit.js <account>
```
Credit deals report per-pair and average CR, but only for pairs whitelisted in `bots.json` (`debtPolicy.lending`) and listed on the current credit offer; everything else is shown as ignored/unpriced and excluded from the average. A borrow-now preview per configured pair shows today's rate.

### Asset Rich List / Top Holder
**File:** `rich_list.ts` (CLI: `dexbot rich`, npm: `npm run richlist`)
**Purpose:** Report the top holder(s) per asset using the chain's `asset_api`
(`get_asset_holders`). Holders come back balance-descending, so this is a live
rich list. Nodes must expose `asset_api` to anonymous logins; the script tries
`dex.iobanker.com` / `api.dex.trading` first and falls back through
`DEFAULT_NODES`.
```bash
# Rich list for one asset (default: node holder limit, usually 100)
dexbot rich <asset>

# Top 10 for several assets
dexbot rich <asset-a> <asset-b> <asset-c> --top 10

# Machine-readable
dexbot rich <asset-a> <asset-b> --json > rich.json
```
Balances reflect only liquid account balances, so they do not sum to total supply.
`--top` is clamped to the node's reported `api_limit_get_asset_holders` (shown
as a note when clamped). Legacy `bit*` MPA names were renamed on-chain without
the `bit` prefix; the script retries an unresolved `bit*` name stripped and notes
the rename. Note:
`get_asset_holders_count` is reported by the node as `distance(range) - 1`, so
the `holders=` figure can be off by one.

### BTS Supply Distribution
**File:** `bts_distribution.ts` (CLI: `dexbot asset bts`; npm: `npm run distribution`)
**Purpose:** Live-chain breakdown of where BTS sits: call-order collateral, global/individual
settlement funds (plus force-settlement debt and parameters), governance tickets, vesting and
legacy balances, liquidity pools, SameT/credit funds, HTLC escrow and asset fee pools. The
remainder is reported as a derived liquid residual and compared with total supply and a derived
circulating float. Also writes a self-contained HTML donut report to
`analysis/charts/bts-distribution.html` (`--html PATH`, `--no-html`).
```bash
dexbot asset bts                                       # terminal + HTML (shorthand: dexbot a bts)
npm run distribution                                   # same, via npm
node dist/scripts/bts_distribution.js --json           # JSON (HTML still written)
node dist/scripts/bts_distribution.js --circulating <reference-supply>
node dist/scripts/bts_distribution.js --holders all    # full rich list (~5 min)
```
Vesting (1.13.x) and legacy (1.15.x) objects have no list API, so both are enumerated by probing
ids with `get_objects` in 1000-id batches (`modules/chain_scan.ts`, halving on nodes that refuse
big batches) and filtered to BTS client-side — the walk covers every asset the node stores there,
because the chain exposes no per-asset index. `--gap N` controls how far past the last live object
the walk continues (default 20000); `--vesting-max` caps the 1.13.x probe.
Call-order collateral uses `api_helper_indexes` `total_in_collateral` (falls back to summing
`get_call_orders`). Top liquid holders come from `asset_api::get_asset_holders`, retrying on a
node that exposes it; exchange tags are name heuristics, not verified identities. `--holders all`
also splits the residual into account balances, blinded balances and order books, and adds
concentration plus balance bands. Read-only: no keys, no transactions.

### Token Distribution
**File:** `token_distribution.ts` (CLI: `dexbot asset <symbol|1.3.x>`; npm: `npm run token-distribution`)
**Purpose:** Per-asset companion to BTS Supply Distribution. Buckets a token into free account
balances, limit orders, liquidity pools, vesting balances, P2P credit offers and deal collateral,
SameT funds, HTLC escrow, accumulated market fees and blinded supply, then reconciles the total
against `current_supply`. Liquidity is grouped by counterpart asset (token/BTS, token/USD, ...);
the HTML report adds a separate liquidity donut plus a 3% price-change liquidity table:
token sellable (price −3%) and buyable (+3%), orderbook + pool combined per market and expressed
as a share of total supply. Writes the report to
`analysis/charts/token-<SYMBOL>-distribution.html`.
```bash
dexbot asset <token>                                   # terminal + HTML (shorthand: dexbot a <token>)
npm run token-distribution -- <token>
node dist/scripts/token_distribution.js <asset-id> --json
node dist/scripts/token_distribution.js <token> --no-orders   # skip the ~6k order queries
```
Read-only: no keys, no transactions. BTS itself is rejected; use `npm run distribution`.

### Configuration Audit
**File:** `validate_bots.ts`
**Purpose:** Check `bots.json` for schema errors or missing required fields.
```bash
# Validate the live bot configuration
node dist/scripts/validate_bots.js
```

### Grid Divergence Audit
**File:** `divergence-calc.ts`
**Purpose:** Measure the "drift" between in-memory grid and disk state using RMS divergence metric.
```bash
# Calculates RMS Error (hardcoded threshold: 1 promille ≈ 3.2% avg error)
# RMS quadratically penalizes large errors - see docs/GRID_RECALCULATION.md
node dist/scripts/divergence-calc.js
```
**Reference:** RMS threshold interpretation in [Grid Recalculation docs](../docs/GRID_RECALCULATION.md)

### Grid Calculation Runner
**File:** `runner.ts`
**Purpose:** Standalone order grid calculation debugger — loads a bot config, initializes the grid, and simulates sync cycles.
```bash
# Default (first bot, 3 cycles)
node dist/scripts/runner.js

# Specific bot, 10 cycles with 1s delay
LIVE_BOT_NAME=my-bot CALC_CYCLES=10 CALC_DELAY_MS=1000 node dist/scripts/runner.js
```
Useful for verifying config produces the expected grid, testing price derivation, and debugging fund allocation.
Requires a live BitShares connection (asset metadata lookups and price derivation are on-chain).

### Print Grid Sample
**File:** `print_grid.ts`
**Purpose:** Demonstrate the grid structure — shows consecutive price levels with percentage differences between adjacent slots.
```bash
node dist/scripts/print_grid.js
```

### Pool History Diagnostics
**File:** `diagnose-pool-history.ts`
**Purpose:** Inspect raw BitShares pool history API responses.
```bash
# Inspect pool history (default pool 1.19.133)
node dist/scripts/diagnose-pool-history.js

# Custom pool, limit, and time range
node dist/scripts/diagnose-pool-history.js --pool 1.19.133 --limit 100 --hours 48 --maxPages 5
```
`--pool` must be a concrete numeric liquidity-pool object ID (`1.19.N`). Placeholders such as `1.19.x` are rejected up front, because the node parses the instance part as a `uint64` and otherwise fails with `Parse Error: Couldn't parse uint64_t`.

### Native Release Gates
**File:** `native_release_gates.ts` (+ `generate_mainnet_corpus_report.ts`)
**Purpose:** Prove the native serialization layer matches the chain byte-for-byte before release.
```bash
# Generate the mainnet corpus report (needs a live node + 50+ blocks)
npm run native:corpus

# Run serializer snapshots + ECC invariants and assert the corpus report
npm run native:release-gates
```
The corpus report lands in `<profiles>/native_validation/mainnet_corpus_report.json`. The gates fail unless the report has `passed=true` and `transactionCount>=50`.

---

## 💻 DEVELOPMENT UTILITIES

### Test Suite Setup
Tests use native Node `assert` — no test framework needed. Sources compile to
`dist/tests/` via `npm run build:tests`, and `npm test` runs them sequentially
through `dist/scripts/run-tests.js` (with a per-test watchdog and diagnostics
summary). See [tests/README.md](../tests/README.md) for details.

### Repository Statistics Analyzer
**File:** `analyze-git.ts` (CLI: `dexbot git`)
**Purpose:** Analyze git history and generate a chart of lines added vs deleted by file.
**Git-only:** Requires a source checkout (`.git` directory); it does not work with global npm installs.
```bash
# Preferred CLI entry point
dexbot git

# Direct invocation
node dist/scripts/analyze-git.js
```
The report is written to `analysis/charts/repo-stats.html`.

### Explicit-`any` Budget Ratchet
**File:** `check_any.ts`
**Purpose:** Count explicit `any` tokens on code lines (comments/JSDoc excluded) and fail when the count rises above the committed budget in `any-budget.json`, keeping `any` removal monotonic. Two scopes are tracked independently: `root` (`modules/`, `market_adapter/`, `analysis/`, `scripts/`, plus root-level `*.ts`) and `claw` (the experimental `claw/` subtree, tests excluded), so the clean root count is not inflated by claw.
```bash
# Compare against any-budget.json
npm run check:any

# Print per-file counts
npm run check:any:list

# Write the current count as the new budget
npm run check:any:update
```

### Credit Renewal Test
**File:** `test-credit-renewal.ts`
**Purpose:** Test credit offer renewal for a specific bot against the live chain.
```bash
npm run test:credit-renewal
```

### Browser Bundle Verification
**File:** `verify-browser-bundle.ts`
**Purpose:** Verify that the browser-safe surface actually bundles for the web (source-level and dist-level checks).
```bash
npm run verify:browser-bundle
```

### Create PM2 Bot Symlinks
**File:** `create-bot-symlinks.sh`
**Purpose:** Create `profiles/<bot>.config.cjs` symlinks pointing to `profiles/ecosystem.config.cjs` so you can run `pm2 start <bot>` directly.
```bash
bash scripts/create-bot-symlinks.sh
```

### Version Sync
**File:** `sync-version.ts`
**Purpose:** Keep DEXBot2-owned package and plugin manifests aligned to the root `package.json` version.
```bash
# Check that package-lock.json and Claw manifests match root package.json
npm run version:check

# Rewrite aligned manifests from root package.json
npm run version:sync
```

---

## 🌳 BRANCH SYNCHRONIZATION

> **Git-only:** These scripts require a `.git` directory and will not work with
> global npm package installs (`npm install -g dexbot`). They are intended for
> source checkout workflows only.

| Script | npm | Action |
|:---|:---|:---|
| `ptest.sh` | `npm run ptest` | push local `test` → `origin/test` |
| `pdev.sh` | `npm run pdev` | sync `test` → `dev` |
| `pmain.sh` | `npm run pmain` | sync `test` → `dev` → `main` |

Before any push, all three scripts run a shared preflight
(`scripts/lib/git_preflight.sh`): one read-only `git ls-remote` against `origin`,
so an unreachable remote or a key the server no longer accepts fails **before** a
branch moves. `pmain.sh` mirrors `dev` and `main` in a single `--atomic` push —
either both move or neither does. Set `DEXBOT_SKIP_GIT_PREFLIGHT=1` to bypass
the preflight.

---

## ⚡ CONVENIENCE WRAPPERS

The following scripts allow you to call `dexbot` commands directly from the `scripts/` directory:

| Wrapper | Target Command | Usage |
|:---|:---|:---|
| `scripts/bots` | `dexbot bots` | `./scripts/bots` |
| `scripts/keys` | `dexbot keys` | `./scripts/keys` |
| `scripts/dexbot` | `dexbot` | `./scripts/dexbot <cmd>` |
| `scripts/unlock` | `dist/unlock.js` | `./scripts/unlock` |
| `scripts/pm2` | `dist/pm2.js` | `./scripts/pm2` |

---

## 📦 NPM SCRIPTS

### Build & Test
| Command | Purpose |
|:---|:---|
| `npm run build` | Compile TypeScript to `dist/` (plain node — no tsx) |
| `npm run build:clean` | Remove stale `dist/` + tsbuildinfo caches, then build |
| `npm run build:tests` | Compile `tests/` to `dist/tests/` (required by `npm test` and `native:*`) |
| `npm run clean` | Remove compiled `dist/` output |
| `npm run typecheck` | TypeScript type checking (`tsc --noEmit`) |
| `npm run typecheck:tests` | Type check the test suite (`tsc -p tsconfig.tests.json --noEmit`) |
| `npm run build:watch` | TypeScript incremental build watcher |
| `npm test` | Build + compile tests + run full suite (excludes live-chain tests) |
| `npm run test:live` | Build + compile tests + run full suite including live-chain tests |

### Code Quality
| Command | Purpose |
|:---|:---|
| `npm run check:any` | Fail if the explicit-`any` count rises above `any-budget.json` |
| `npm run check:any:list` | Print per-file explicit-`any` counts |
| `npm run check:any:update` | Write the current explicit-`any` count as the new budget |

### Runtime
| Command | Purpose |
|:---|:---|
| `npm run unlock` | Build + single-prompt credential unlock (full bot) |
| `npm run claw:unlock` | Build + single-prompt unlock (claw-only mode) |
| `npm run pm2:unlock` | Build + launch full bot via PM2 ecosystem |
| `npm run pm2:claw-only` | Build + launch claw-only PM2 process |
| `npm run pm2:start` | Unlock + start bots via PM2 (alias of `pm2:unlock`) |
| `npm run pm2:stop` | Stop all dexbot PM2 processes via the launcher |

### Version
| Command | Purpose |
|:---|:---|
| `npm run version:sync` | Rewrite plugin/manifest versions from root `package.json` |
| `npm run version:check` | Verify all version manifests match root `package.json` |

### Analysis
| Command | Purpose |
|:---|:---|
| `npm run market-adapter:fetch-cex-synthetic` | Fetch CEX synthetic data for market adapter |
| `npm run analysis:tradingview` | TradingView-style chart export |
| `npm run analysis:trade-pnl` | Trade PnL analysis from fill data |
| `npm run analysis:grid-check` | Last-fill-guard check (`grid_correction_check.ts`) |
| `npm run analysis:resolve-accounts` | Batch-resolve on-chain bot accounts (`resolve_bot_accounts.ts`) |
| `npm run richlist` | Per-asset rich list / top holder (`rich_list.ts`) |
| `npm run distribution` | BTS supply distribution + HTML donut report (`bts_distribution.ts`) |
| `npm run token-distribution` | Per-token supply distribution + HTML report (`token_distribution.ts`) |
| `npm run ama:chart:lp-local` | Generate local LP comparison chart |
| `npm run lp:chart` | Generate uPlot LP chart |
| `npm run test:credit-renewal` | Test credit offer renewal for a specific bot |
| `npm run verify:browser-bundle` | Verify browser-safe surface bundles correctly |

### Native Release Gates
| Command | Purpose |
|:---|:---|
| `npm run native:corpus` | Build mainnet corpus report proving byte-for-byte native serialization parity |
| `npm run native:serial-snapshots` | Run native serializer snapshot tests |
| `npm run native:ecc-invariants` | Run native ECC key/sign/verify invariant tests |
| `npm run native:release-gates` | Run serial + ECC gates and assert a valid mainnet corpus report |

---

## 📈 CHART GENERATION

`dexbot tv` and `dexbot dw` share the `chart_command.ts` pipeline (target
resolution, source routing, cached monthly candle chunks); only the renderer
differs. Both write to `analysis/charts/` and support `--month`, `--feed`,
`--pool`, `--book` and `--chart`.

### TradingView (`dexbot tv`)
**File:** `tv.ts`
One-step 1h chart for a bot, pool or pair, with AMA + order overlay. Bot charts
load `profiles/orders/<botKey>.json` automatically.
**Output:** `tv_<bot|pool_<id>|<a>_<b>>_1h_<N>m.html` (`_feed` for feed charts)
```bash
dexbot tv <bot>                                  # bot, 3 months
dexbot tv 133 --month 6                          # pool by id
dexbot tv <pool-token-symbol> --month 6          # pool by its LP share-asset symbol
dexbot tv TOKENA/TOKENB --month 1 --chart analysis/charts/custom.html
dexbot tv TOKENA/BTS --feed --month 1            # MPA price feed
```

### Dynamic Weight (`dexbot dw`)
**File:** `dw.ts`
Same pipeline and flags as `tv`; renders the dynamic-weight research chart
(AMA slope + Kalman blend, Hurst/PE regime gate). Research knobs (`--alpha`,
`--gain`, `--dw`, `--lb`, `--clip`) live on `analysis/analyze_dynamic_weight.js`.
**Output:** `dw_<bot|pool_<id>|<a>_<b>>_1h_<N>m.html` (`_feed` for feed charts)
```bash
dexbot dw <bot>
dexbot dw 133 --month 6
dexbot dw <pool-token-symbol> --month 6
dexbot dw TOKENA/TOKENB --month 1 --chart analysis/charts/custom.html
dexbot dw TOKENA/BTS --feed --month 1
```

### PnL Report (`dexbot pnl`)
**File:** `pnl.ts` (thin entry; analyzer + HTML renderer: `analysis/trade_profitability.ts` + `analysis/pnl_report.ts`)
**Purpose:** Resolve a bot profile (local-first), account name, or `1.2.x` id, fetch the account's fills for the requested window, and write a self-contained HTML PnL report (summary cards, performance metrics, realized-lot table). Terminal tables stay available by running the analyzer directly.
**Output:** `analysis/charts/pnl_<bot|account>[_<pair>]_<range>.html`
**Cache:** per-account fill shards under `analysis/cache/fills/` (settled months are reused; the unsettled tail is re-queried). `--refresh-account` bypasses it.
```bash
# HTML PnL report for a local bot, last 3 months
dexbot pnl <bot> --month 3
# Filter a multi-pair account to one pair
dexbot pnl 1.2.123456 --month 6 --pair TOKENA/BTS
# Custom output path
dexbot pnl <bot> --month 1 --report analysis/charts/custom-pnl.html
```

### LP Chart
**File:** `generate_lp_chart.ts`
**Purpose:** Generate the standard uPlot LP chart output.
```bash
# Generate the default LP chart flow
npm run lp:chart -- --data <lp-export.json>
# --file is an alias for --data
```

### Local LP Comparison Chart
**File:** `analysis/ama_fitting/generate_unified_comparison_chart.ts`
**Purpose:** Generate the local LP comparison chart from an LP candle export.
**Output:** `analysis/charts/lp_chart_<interval>_UNIFIED_COMPARISON.html`
```bash
# Generate the local LP comparison chart
npm run ama:chart:lp-local -- --data <lp-export.json>
```

---

## 📚 DOCUMENTATION REFERENCES

For understanding the systems these scripts interact with:
- **Module Architecture**: See [modules/README.md](../modules/README.md)
- **Copy-on-Write Pattern**: See [docs/COPY_ON_WRITE_MASTER_PLAN.md](../docs/COPY_ON_WRITE_MASTER_PLAN.md) for rebalancing architecture
- **Fund Accounting**: See [docs/FUND_MOVEMENT_AND_ACCOUNTING.md](../docs/FUND_MOVEMENT_AND_ACCOUNTING.md)
- **Grid Divergence**: See [docs](../docs/README.md) for RMS threshold explanations
- **Logging System**: See [docs/LOGGING.md](../docs/LOGGING.md) for log configuration and levels

## ⌨️ TERMINAL PRODUCTIVITY

Boost your workflow by adding these aliases to your `~/.bashrc` or `~/.zshrc`:

```bash
# DEXBot2 Shortcuts
alias dbu='dexbot update'
alias dbc='bash scripts/clear-logs.sh'
alias dbr='bash scripts/clear-orders.sh'
alias dba='bash scripts/clear-all.sh'
alias dbv='node dist/scripts/validate_bots.js'
alias dbd='node dist/scripts/divergence-calc.js'

# Tail the updater log in a separate pane
tail -f <profiles>/logs/dexbot-update.log
```

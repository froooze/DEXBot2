# DEXBot2 /scripts CLI Documentation

This guide provides a terminal-focused reference for the maintenance and diagnostic utilities available in the `scripts/` directory.

---

## 🛠️ CORE MAINTENANCE

### Update DEXBot2
**File:** `update.ts` (shim: `update.js`)
**Purpose:** Perform a safe, production-ready update.
```bash
# Pull latest code, install deps, and restart PM2
dexbot update
```
*Note: Protects your `profiles/` directory during the update process.*

---

## 🧹 CLEANING & RESET (DANGER ZONE)

All clear/reset scripts resolve their directories via `scripts/lib/dexbot-paths.sh`,
which mirrors `modules/paths.ts`. Defaults depend on the install type:

| Install | Profile root | Market adapter data/state | Claw data |
|---------|--------------|---------------------------|-----------|
| Source checkout | `<repo>/profiles` | `<repo>/market_adapter/{data,state}` | `<repo>/claw/data` |
| Global npm (`npm i -g dexbot`) | `~/.config/dexbot2/profiles` | `<profiles>/market_adapter/{data,state}` | `<profiles>/claw/data` |

Env overrides: `DEXBOT_PROFILE_ROOT`, `DEXBOT_MARKET_ADAPTER_DATA_DIR`,
`DEXBOT_MARKET_ADAPTER_STATE_DIR`, `DEXBOT_CLAW_DATA_DIR`. When run through the
`dexbot` CLI, the resolved runtime dirs are passed automatically, so the CLI
always clears the same dirs the runtime uses.

### Wipe Logs
**File:** `clear-logs.sh`
**Purpose:** Delete all bot `.log` and `.jsonl` files, including `profiles/logs/market_adapter.log`.
```bash
# IRREVERSIBLE: Deletes all files in profiles/logs/*.log and *.jsonl, including market_adapter.log
# Prompts for confirmation before deleting.
bash scripts/clear-logs.sh
```

### Wipe Orders
**File:** `clear-orders.sh`
**Purpose:** Delete all persistent order state files.
```bash
# IRREVERSIBLE: Deletes all files in profiles/orders/*
# Prompts for confirmation before deleting.
bash scripts/clear-orders.sh
```

### Clear Market Adapter State
**File:** `clear-market-adapter.sh`
**Purpose:** Delete all market adapter candle data, state files, and runtime logs.
```bash
# IRREVERSIBLE: Removes market_adapter/{data,state}/ and profiles/logs/{market_adapter,dexbot-adapter,dexbot-adapter-error}.log
# (paths relocate under the profiles dir for global npm installs)
# Prompts for confirmation before deleting.
bash scripts/clear-market-adapter.sh
```

### Wipe Orders + Logs + Market Adapter + Claw
**File:** `clear-all.sh`
**Purpose:** Delete order state files, log files, market adapter data/state, and claw data in one confirmed operation.
```bash
# IRREVERSIBLE: Deletes profiles/orders/*, profiles/logs/*.{log,jsonl},
# market_adapter/{data,state}/*, and claw data (positions.json, watcher-health.json, memu/) under
# <profiles>/claw/data (or <repo>/claw/data for source checkouts).
# Prompts for confirmation before deleting.
bash scripts/clear-all.sh
```

### Reset Settings
**File:** `reset-settings.sh`
**Purpose:** Delete the three settings files and restore built-in defaults on next run.
```bash
# IRREVERSIBLE: Deletes profiles/general.settings.json, profiles/market_profiles.json,
# and profiles/market_adapter_settings.json
# Prompts for confirmation before deleting.
bash scripts/reset-settings.sh
```

---

## 📊 DIAGNOSTICS & VALIDATION

### Configuration Audit
**File:** `validate_bots.ts`
**Purpose:** Check `bots.json` for schema errors or missing required fields.
```bash
# Validate the live bot configuration
node dist/scripts/validate_bots.js
```

### Market Adapter Whitelist Generation
**File:** `generate_market_adapter_whitelist.ts`
**Purpose:** Generate `profiles/market_adapter_whitelist.json` from bots whose `gridPrice` uses AMA mode.
```bash
# Add missing AMA bots from profiles/bots.json to profiles/market_adapter_whitelist.json.
# Existing entries are preserved; new entries enable AMA only and leave dynamicWeight and range scaling disabled.
dexbot white

# Add missing AMA bots with dynamicWeight enabled for newly generated entries
dexbot white --dynamic-weight

# Add missing AMA bots with range scaling (asymmetricBounds) enabled for newly generated entries
dexbot white --asymmetric-bounds

# Overwrite existing entry for a specific bot (implies overwrite for that key only; other bots unchanged)
dexbot white --dynamic-weight --bot <botKey>
dexbot white --asymmetric-bounds --bot <botKey>

# Remove whitelist entries for bots no longer in profiles/bots.json
dexbot white --prune

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

### Grid Trading Analysis
**File:** `analyze-orders.ts`
**Purpose:** Analyze grid trading metrics and order distribution patterns.
```bash
# Analyzes spread accuracy, geometric consistency, and fund distribution
node dist/scripts/analyze-orders.js
```

For AMA bots (`gridPrice: ama`) the analyzer reads `<botKey>.dynamicgrid.json`
and, when fresh (`2 × MARKET_ADAPTER.RUNTIME_DEFAULTS.pollSeconds`, default 2h),
shows live weights with color: higher = red (losing), lower = green (winning),
static = grey. Stale snapshot appends a red `(adapter offline)` alert to the
static weights.

### Kibana Candle Diagnostics
**File:** `diagnose-kibana-candles.ts`
**Purpose:** Fetch raw Kibana LP candles for a specific pool to verify trading activity.
```bash
node dist/scripts/diagnose-kibana-candles.js
```

### Pool History Diagnostics
**File:** `diagnose-pool-history.ts`
**Purpose:** Inspect raw BitShares pool history API responses.
```bash
# Inspect pool history (default pool 1.19.133)
node dist/scripts/diagnose-pool-history.js

# Custom pool, limit, and time range
node dist/scripts/diagnose-pool-history.js --pool 1.19.x --limit 100 --hours 48 --maxPages 5
```

### Print Grid Sample
**File:** `print_grid.ts`
**Purpose:** Demonstrate the grid structure — shows consecutive price levels with percentage differences between adjacent slots.
```bash
node dist/scripts/print_grid.js
```

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

## 🔍 GIT & DEVELOPMENT WORKFLOW

### Interactive Git Changes Monitor
**File:** `git-viewer.sh`
**Purpose:** Interactive monitor for uncommitted, committed, and pushed changes.
```bash
# Launch interactive git changes viewer with fzf search
bash scripts/git-viewer.sh
```

**Features**:
- View uncommitted (working tree) changes
- View committed (staged) changes
- View pushed vs. remote-tracking changes
- Smart auto-refresh (1s for local, 15s for remote)
- Fuzzy search with `fzf` for finding files
- Toggle between full file view and diff-only view

**Usage**:
```bash
# Press '1' to view all changes
# Press '2' to search uncommitted files (with fzf)
# Press '3' to search unpushed commits (with fzf)
# Press '4' to search pushed commits (with fzf)
# Press 'q' to quit
```
Inside file viewer: `f` full file, `d` diff view, `q` back to search, `b` main menu.

---

## 💻 DEVELOPMENT UTILITIES

### Test Suite Setup
Tests use native Node `assert` — no test framework needed. Sources compile to
`dist/tests/` via `npm run build:tests`, and `npm test` runs them sequentially
through `dist/scripts/run-tests.js` (with a per-test watchdog and diagnostics
summary). See [tests/README.md](../tests/README.md) for details.

### Repository Statistics Analyzer
**File:** `analyze-git.ts`
**Purpose:** Analyze git history and generate a chart of lines added vs deleted by file.
```bash
node dist/scripts/analyze-git.js
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

### Synchronize test → dev → main
**File:** `pmain.sh` (also: `npm run pmain`)
**Purpose:** Sync local test branch through dev to main remote.
```bash
# Push test → dev → main
bash scripts/pmain.sh
# OR
npm run pmain
```

### Synchronize test → dev
**File:** `pdev.sh` (also: `npm run pdev`)
**Purpose:** Sync local test branch to dev remote.
```bash
# Push test → dev
bash scripts/pdev.sh
# OR
npm run pdev
```

### Synchronize local test → origin/test
**File:** `ptest.sh` (also: `npm run ptest`)
**Purpose:** Push local test branch to remote.
```bash
# Push test to origin/test
bash scripts/ptest.sh
# OR
npm run ptest
```

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

### Runtime
| Command | Purpose |
|:---|:---|
| `npm run unlock` | Build + single-prompt credential unlock (full bot) |
| `npm run claw:unlock` | Build + single-prompt unlock (claw-only mode) |
| `npm run pm2:unlock` | Build + launch full bot via PM2 ecosystem |
| `npm run pm2:claw-only` | Build + launch claw-only PM2 process |
| `npm run pm2:start` | Start PM2 processes from ecosystem config |
| `npm run pm2:stop` | Stop PM2 processes from ecosystem config |

### Branch Sync *(git checkout only)*
| Command | Purpose |
|:---|:---|
| `npm run ptest` | Push local test → origin/test |
| `npm run pdev` | Sync local test → dev |
| `npm run pmain` | Sync local test → dev → main |

### Version
| Command | Purpose |
|:---|:---|
| `npm run version:sync` | Rewrite plugin/manifest versions from root `package.json` |
| `npm run version:check` | Verify all version manifests match root `package.json` |

### Analysis
| Command | Purpose |
|:---|:---|
| `npm run market-adapter:whitelist` | Generate/update whitelist from AMA-configured bots |
| `npm run market-adapter:fetch-cex-synthetic` | Fetch CEX synthetic data for market adapter |
| `npm run analysis:derivatives` | Derivative analysis report |
| `npm run analysis:tradingview` | TradingView-style chart export |
| `npm run analysis:trade-pnl` | Trade PnL analysis from fill data |
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

### TradingView (`dexbot tv`)
**File:** `tv.ts`
**Purpose:** One-step TradingView-style 1h chart for a bot (with AMA + order overlay), pool, or pair. Fetches candles in monthly Kibana chunks (pool-first with order-book fallback; `--feed` for MPA price-feed history), then renders via `analysis/tradingview/`. Bot charts pick up the order overlay from `profiles/orders/<botKey>.json` automatically.
**Output:** `analysis/charts/tv_<bot|pool_<id>|<a>_<b>>_1h_<N>m.html` (`_feed` suffix for feed charts)
```bash
# Bot chart (default: 3 months)
dexbot tv <bot>
# Pool or pair, custom window
dexbot tv 133 --month 6
dexbot tv TOKENA/TOKENB --month 1 --chart analysis/charts/custom.html
# MPA price-feed history instead of market candles (opt-in)
dexbot tv BTS/HONEST.USD --feed --month 1
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

### Derivative Trend Analysis
**File:** `analysis/analyze_derivatives.ts`
**Purpose:** Generate the derivative analysis report.
```bash
# Generate the derivative analysis report
npm run analysis:derivatives -- --source json --file <file.json>
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
```

---

## 💡 PRO-TIPS FOR TERMINAL USERS

**Monitor live updates while running a script:**
```bash
# Tail the update log in a separate pane
tail -f <profiles>/logs/dexbot-update.log
```

**Run a specific bot dry-run from the CLI:**
```bash
# Force a clean start for 'my-bot'
bash scripts/clear-orders.sh && BOT_NAME=my-bot dexbot test
```

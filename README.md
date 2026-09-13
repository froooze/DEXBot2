# DEXBot2

DEXBot2 is the first open source trading bot with zero runtime dependencies and a fully adaptive market making strategy.

<p align="center">
  <img src="docs/media/DEXBot2.webp" alt="DEXBot2 hero banner" width="1200">
</p>

## Contents

- [Quick Start](#-quick-start)
- [Installation](#-installation)
- [Configuration](#-configuration)
- [Zero-Dependency Process Management](#-zero-dependency-process-management)
- [Bot Management](#-bot-management)
- [PM2 Process Management](#-pm2-process-management)
- [Documentation](#-documentation)
- [Contributing](#-contributing)
- [License](#-license)
- [Links](#-links)

## ✨ Features

- **Grid Trading** — geometric order grids that rebalance as price moves
- **Adaptive Signals** — AMA and trend inputs tune grid placement
- **Credit & MPA** — credit offer and debt workflows
- **Runtime Safety** — replay-safe fills, sync recovery, and cleanup
- **Secure Ops** — encrypted keys and credential daemon

## 🌱 Quick Start

```bash
# Requires Node.js v22.12 or newer
npm i -g dexbot

dexbot key                 # Set up master password and import keys
dexbot bot                 # Create and manage bot configurations
dexbot start               # Start DEXBot2
```

Detailed setup: [Installation](#-installation).

### First Run

New to BitShares? Work through the [BitShares Onboarding Tutorial](docs/BITSHARES_ONBOARDING.md) first — it covers creating and funding an account, choosing the right key, and running your first bot.

### Disclaimer — Use At Your Own Risk

- This software is provided "as-is" without warranty.
- Secure your keys. Never share private keys or passwords.
- The authors and maintainers are not responsible for losses.

## 📥 Installation

### Prerequisites

You'll need **Git** and **Node.js** v22.12 or newer installed.

#### Linux Users

Install Git:

```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install git

# Arch/Manjaro
sudo pacman -S git

# Fedora/RHEL
sudo dnf install git
```

Most distro repos ship an outdated `nodejs` package, so install Node from [nodejs.org](https://nodejs.org/en/download).

```bash
# e.g. via nvm (from https://nodejs.org/en/download)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.6/install.sh | bash
\. "$HOME/.nvm/nvm.sh"
nvm install 24
```

Verify both installations:

```bash
node --version && npm --version && git --version
```

#### macOS Users

Use Homebrew to install Node.js and Git:
```bash
# Install Homebrew if not already installed
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install Node.js and Git
brew install node git
```

#### Windows Users

1. Install **Git** from [git-scm.com](https://git-scm.com/install/windows) (accept defaults, restart after)
2. Install **Node.js LTS** from [nodejs.org](https://nodejs.org/en/download) (accept defaults, restart after)
3. Verify installation in Command Prompt:
   ```cmd
   node --version && npm --version && git --version
   ```
   All three should display version numbers.

### Install DEXBot2 from npm (recommended)

```bash
npm i -g dexbot
```

### Install DEXBot2 from source (developers)

```bash
git clone https://github.com/froooze/DEXBot2.git && cd DEXBot2
npm install
npm link
```

### Where your data lives

Both installs use the same CLI and store all user state — keys, `bots.json`, logs — in `~/.config/dexbot2/profiles` (Windows: `%USERPROFILE%\.config\dexbot2\profiles`). State lives outside the repo/package tree, so it survives reinstalls and `npm update -g`. A source checkout that already contains a populated `profiles/` directory keeps using it. Override the location with `DEXBOT_PROFILE_ROOT` (see the [developer guide](docs/developer_guide.md)).

## 🔧 Configuration

### Create Your Bot

1. Set up your master password and import your BitShares **active** key (WIF):

   ```bash
   dexbot key
   ```

2. Create a bot through the interactive prompts:

   ```bash
   dexbot bot
   ```

   This stores your configuration in `bots.json` in the [profiles directory](#where-your-data-lives). The generated
   defaults are a good starting point — the next step walks through the few
   options worth tuning.

### Recommended Bot Setup

Keep the default settings first, and tune these:

1. **Tune `targetSpreadPercent`** — controls profit room per completed cycle:
   profit ≈ `spread - increment - fees`. A wider spread targets more profit per
   cycle but trades less often.

2. **Tune `incrementPercent`** — controls order steps and order size. Smaller
   increments create more grid levels and smaller orders; larger increments
   create fewer levels and larger orders. Smaller increments cycle faster —
   higher profits, but more fees.

3. **Tune `weightDistribution`** (optional) — per-side sizing control. Higher
   weight = more funds in orders near the market price; lower weight = funds
   shifted toward the grid edge. Range `-1` (super-valley) to `2`
   (super-mountain); the default `{ "sell": 1.0, "buy": 1.0 }` suits most
   setups.

4. **Set `gridPrice` to `"ama"`** — so the market adapter can center the grid
   on AMA. Pick a specific preset if desired: `"ama1"` is the fastest,
   `"ama4"` the slowest, and `"ama"` uses the pair's default preset.

5. **Generate the market-adapter whitelist:**

   ```bash
   dexbot white
   ```

   This writes `market_adapter_whitelist.json` in the profiles directory. New AMA bots get AMA
   live writes only; dynamic weights and range scaling are disabled by default. Use
   `dexbot white --dynamic-weight` or `dexbot white --asymmetric-bounds` to opt
   newly generated entries into those features; existing entries are preserved.
   To overwrite an existing bot, include `--bot <botKey>` with the desired flags.

6. **Start DEXBot2** with `dexbot start`.

7. **Tune `minPrice` / `maxPrice`** around the market's volatility range. Once
   AMA is active, tighten them around the maximum expected market volatility
   instead of using an unnecessarily wide range.

### Bot Options Reference

Configuration options from `dexbot bot`, stored in `bots.json` in the profiles directory:

> **Prefer relative values** — use dynamic price sources where available: `"pool"` (liquidity-pool price) or `"book"` (order-book mid) for `startPrice`, `"ama"` for `gridPrice`, `"2x"`-style multipliers for `minPrice` / `maxPrice`, and `"100%"`-style percentages for funds (`botFunds`). Relative values rescale automatically as the market moves; fixed numbers do not. The bot editor highlights these inputs live: **green** = relative/dynamic (recommended), **red** = fixed absolute value.

<details><summary><mark>Full parameter reference (click to expand)</mark></summary>

| Parameter | Type | Description |
| :--- | :--- | :--- |
| **`assetA`** | string | Base asset |
| **`assetB`** | string | Quote asset |
| **`name`** | string | Friendly name for logging and CLI selection |
| **`active`** | boolean | `false` to keep config without running |
| **`dryRun`** | boolean | Simulate orders without broadcasting |
| **`preferredAccount`** | string | BitShares account name for trading |
| **`startPrice`** | num \| str | Initial price and adapter source. Default `"pool"` uses the liquidity-pool price; `"book"` uses the live order book mid price (best bid/ask); a number uses a fixed anchor. |
| **`poolRef`** | string \| null | Optional pinned pool ID for `startPrice: "pool"`. Overrides pool discovery with a direct fetch (e.g. `"1.19.48"` or `"48"`). Useful when the trading pair has no native pool. Default `null`. |
| **`minPrice`** | num \| str | Lower bound. Default `"2x"` means `gridPrice / 2` when AMA is active, otherwise `startPrice / 2`. |
| **`maxPrice`** | num \| str | Upper bound. Default `"2x"` means `gridPrice * 2` when AMA is active, otherwise `startPrice * 2`. |
| **`gridPrice`** | num \| str \| null | Grid reference. Use `"ama"` for the recommended AMA center (`"ama"` picks the pair's default preset; `"ama1"`–`"ama4"` pin fastest to slowest); `null` falls back to `startPrice`; numeric values use that fixed value. |
| **`incrementPercent`** | number | Geometric step between orders. Default `0.5` = 0.5%. |
| **`targetSpreadPercent`** | number | Width of the empty spread zone between buy and sell orders. Default `2` = 2%. Profit per completed cycle ≈ `spread - increment - fees`. |
| **`weightDistribution`** | object | Advanced sizing control per side. Range `-1` to `2`: `-1` = super-valley, `0` = valley, `0.5` = neutral, `1` = mountain (default), `2` = super-mountain. Higher weight = more funds in orders near the market price; lower weight = more funds shifted toward the grid edge. Default `{ Sell: 1.0, Buy: 1.0 }`; leave unchanged for normal setup. |
| **`botFunds`** | object | Capital: `{ Sell: "100%", Buy: 100% }`. Numbers or percentage strings |
| **`activeOrders`** | object | Target active orders per side: `{ S: 20, B: 20 }` |
| **`reserveOrders`** | object | Edge-pinned insurance orders resting live outside the active window, to catch fat fingers: `{ S: 0, B: 0 }` |

</details>

### General Options (Global)

Global settings via `dexbot bot`, stored in `general.settings.json` in the profiles directory:

<details><summary><mark>Global settings reference (click to expand)</mark></summary>

- **Grid Health**: Grid Ratio Regeneration % (default `3%`), RMS Divergence Threshold % (default `14.3%`), AMA Delta Threshold % (default `1%`)
- **Order Recovery**: Partial Dust Threshold % (default `5%`), Dust Cancel Delay (default `30s`, `-1` = off, `0` = instant)
- **Node Configuration**: Node List (10 default public BitShares nodes), Health Check Interval (default `240 min`), Preferred Node (default `none`)
- **Log Level**: `debug`, `info`, `warn`, `error`, `critical`. Fine-grained category control via `LOGGING_CONFIG` (see [Logging](docs/LOGGING.md))
- **Updater**: Active (default `OFF`), Branch (`auto`/`main`/`dev`/`test`), Interval (default `1 day`), Time (default `00:00`)

</details>

### Constants and Overrides

Defaults in [`modules/constants.ts`](modules/constants.ts) are overridable at global, pair, and bot level via `general.settings.json`, `market_profiles.json`, and `market_adapter_settings.json` in the profiles directory. See [market_adapter/README.md](market_adapter/README.md#settings-and-overrides) for examples.

## 🎯 Zero-Dependency Process Management

`dexbot start` is the recommended production runtime (global install). Repo-root users can run `./unlock` instead. It runs the selected bot set as one monolithic bot process, with the credential daemon and market adapter in separate helper processes. Monolithic start/stop/reload/restart controls apply to the whole runtime, not to individual bots.

```bash
dexbot start/stop          # Stop/start the monolithic runtime
dexbot start --dryrun      # Dry-run (no transactions broadcast)
dexbot reload              # Reload the runtime (leaves credential daemon untouched)
dexbot restart             # Restart the runtime (re-unlocks credential daemon)
dexbot delete              # Shut down and clean up
```

First-run details and common mistakes are covered in the [BitShares Onboarding Tutorial](docs/BITSHARES_ONBOARDING.md).

## 🛠️ Bot Management

```bash
dexbot key                 # Master password/keyring
dexbot bot                 # Interactive bot configurator
dexbot white               # AMA whitelist; dynamic weights and range scaling off by default

dexbot reset {all|<bot>}   # Regenerate grid
dexbot disable {all|<bot>} # Disable bot in config
dexbot enable {all|<bot>}  # Enable bot in config

dexbot stat                # Runtime status (unlock or PM2)
dexbot order [<bot>]       # Analyze order grids
dexbot order --export      # Export as HTML to analysis/charts/
dexbot tv <bot|pool|A/B>   # TradingView 1h chart with AMA overlay (default: 3 months)
dexbot credit [<bot>]      # Live summed MPA + borrowed-credit positions per asset per bot

dexbot update              # Update DEXBot2
dexbot clear               # Clear log files
dexbot default             # Reset settings to defaults
```

## 🎯 PM2 Process Management

PM2 is optional — `dexbot start` is the native solution.

```bash
dexbot pm2 [<bot>]                         # Start with PM2
dexbot pm2 reload {all|<bot>}              # Reload managed apps, dexbot-cred untouched
dexbot pm2 restart {all|<bot>|dexbot-cred} # Safe restart
dexbot pm2 stop {all|<bot>}                # Stop (via wrapper)
dexbot pm2 delete {all|<bot>}              # Delete (via wrapper)
pm2 logs [<bot>]                           # Real-time logs
```

Always use `dexbot pm2 restart` instead of raw `pm2 restart all` — the wrapper safely handles the credential daemon. If the credential daemon stops, rerun `dexbot pm2`.

> Repo-root users can use `./pm2` instead of `dexbot pm2`.

Logs are written to `logs/` in the profiles directory in all modes: the monolithic runtime uses `dexbot.log` / `dexbot-error.log`, and per-bot output uses `<bot>.log` / `<bot>-error.log`.

## 📚 Documentation

### User-Facing Workflows

- **[BitShares Onboarding](docs/BITSHARES_ONBOARDING.md)** - Beginner tutorial: create and fund an account, choose the right key, and run your first bot
- **[Market Adapter](market_adapter/README.md)** - AMA pricing, grid triggers, dynamic weights, and collateral advisory signals
- **[MPA and Credit Usage](docs/MPA_CREDIT_USAGE.md)** - Bot-scoped debt policy, MPA borrowing, and credit offer workflows
- **[Analysis](analysis/README.md)** - Research runners, chart generators, and tuning helpers for AMA fitting, trend detection, bot fitting, and TradingView exports
- **[Claw](claw/README.md)** - Bridge setup, launcher commands, short MPA workflow, and example commands

### Operational & Security

- **[Credential Security](docs/CREDENTIAL_SECURITY.md)** - Key handling, daemon-backed signing, and runtime file hardening
- **[Grid Recalculation](docs/GRID_RECALCULATION.md)** - Market-adapter bootstrap/delta/slope resets, divergence correction, fund regeneration, and runtime trigger handling
- **[Grid Reconciliation](docs/GRID_RECONCILE.md)** - Startup 3-phase reconcile, offline fill detection, and stale surplus cleanup
- **[Logging](docs/LOGGING.md)** - Logging system documentation
- **[Docker](docs/docker.md)** - Container build, release images, and secure startup

### Reference Docs

- **[Docs Index](docs/README.md)** - Main documentation hub
- **[Architecture](docs/architecture.md)** - System design, fill processing pipeline, and testing strategy
- **[Lifecycle](docs/LIFECYCLE.md)** - End-to-end walkthrough: startup, fill-driven, and AMA-driven flows with diagrams
- **[Evolution Report](docs/EVOLUTION.md)** - Project timeline, architecture phases, and release history
- **[Developer Guide](docs/developer_guide.md)** - Development guide, environment variables, examples, and glossary
- **[Workflow](docs/WORKFLOW.md)** - Project workflow and contribution guide
- **[Fund Movement & Accounting](docs/FUND_MOVEMENT_AND_ACCOUNTING.md)** - Fund accounting, grid topology, and rotation mechanics
- **[Copy-on-Write Plan](docs/COPY_ON_WRITE_MASTER_PLAN.md)** - Copy-on-Write grid architecture
- **[Claw API Boundary](claw/docs/AI_BOT_LIBRARY_API.md)** - Responsibility split between the AI layer and the DEXBot2 execution layer

## 🤝 Contributing

1. Fork the repository and create a feature branch
2. Make your changes and test with `npm test`
3. Submit a pull request

## 📄 License

MIT License - see LICENSE file for details

## 🔗 Links

- [![Telegram](https://img.shields.io/badge/Telegram-%40DEXBot__2-26A5E4?logo=telegram&logoColor=white)](https://t.me/DEXBot_2)
- [![Website](https://img.shields.io/badge/Website-dexbot.org-4FC08D?logo=internet-explorer&logoColor=white)](https://dexbot.org/)
- [![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/froooze/DEXBot2)
- [![Awesome BitShares](https://camo.githubusercontent.com/9d49598b873146ec650fb3f275e8a532c765dabb1f61d5afa25be41e79891aa7/68747470733a2f2f617765736f6d652e72652f62616467652e737667)](https://github.com/bitshares/awesome-bitshares)
- [![Reddit](https://img.shields.io/badge/Reddit-r%2FBitShares-ff4500?logo=reddit&logoColor=white)](https://www.reddit.com/r/BitShares/)

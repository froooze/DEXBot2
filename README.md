# DEXBot2

A sophisticated market making bot for the BitShares Decentralized Exchange (DEX), implementing optimized staggered order strategies for automated trading.

## 🚀 Features

- **Staggered Order Grid**: Creates geometric order grids around market price for efficient market making.
- **Dynamic Rebalancing**: Automatically adjusts orders after fills to maintain optimal spread.
- **Multi-Bot Support**: Run multiple bots simultaneously on different trading pairs.
- **PM2 Process Management**: Automatic restart and monitoring for production use.
- **Master Password Security**: Encrypted key storage with RAM-only password handling.

## ⚠️ Disclaimer — Use At Your Own Risk

- This software is in beta stage and provided "as‑is" without warranty.
- Secure your keys and secrets. Do not commit private keys or passwords to anyone — use `profiles/` for live configuration and keep it out of source control.
- The authors and maintainers are not responsible for losses.

## 📦 Installation

### Prerequisites

You'll need **Git** and **Node.js** installed on your system.

#### Windows Users - First Time Setup

If you don't have Node.js installed yet, follow these steps:

**Step 1: Install Node.js**
1. Go to [nodejs.org](https://nodejs.org/) and download the **LTS (Long Term Support)** version
2. Run the installer and follow the prompts (accept all default settings)
3. Restart your computer after installation completes
4. Open Command Prompt or PowerShell and verify installation:
   ```bash
   node --version
   npm --version
   ```
   Both commands should display version numbers if Node.js is installed correctly.

**Step 2: Install Git (if not already installed)**
1. Go to [git-scm.com](https://git-scm.com/) and download the Windows installer
2. Run the installer and follow the prompts (accept default settings)
3. Restart your computer
4. Verify Git installation in Command Prompt or PowerShell:
   ```bash
   git --version
   ```

#### macOS Users

Use Homebrew to install Node.js and Git:
```bash
# Install Homebrew if not already installed
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install Node.js and Git
brew install node git
```

#### Linux Users

Use your package manager:
```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install nodejs npm git

# Fedora/RHEL
sudo dnf install nodejs npm git
```

### Clone and Setup DEXBot2

```bash
# Clone the repository and switch to folder
git clone https://github.com/froooze/DEXBot2.git
cd DEXBot2

# Install dependencies
npm install

# Set up your master password and keyring
node dexbot keys

# Create and configure your bots
node dexbot bots
```

### Updating DEXBot2

To update DEXBot2 to the latest version from the main branch:

```bash
# Run the update script from project root
bash scripts/update.sh
```

The update script automatically:
- Fetches and pulls the latest code from GitHub
- Installs any new dependencies
- Reloads PM2 processes if running
- Ensures your `profiles/` directory is protected and unchanged
- Logs all operations to `update.log`

## 🔧 Configuration

Define each bot in `profiles/bots.json`. A minimal structure looks like this:

```json
{
  "bots": [
    {
      "name": "your-name",
      "active": true,
      "dryRun": true,
      "preferredAccount": "example-account",
      "assetA": "IOB.XRP",
      "assetB": "BTS",
      "marketPrice": "pool",
      "minPrice": "4x",
      "maxPrice": "4x",
      "incrementPercent": 1,
      "targetSpreadPercent": 5,
      "weightDistribution": { "sell": 0.5, "buy": 0.5 },
      "botFunds": { "sell": "100%", "buy": "100%" },
      "activeOrders": { "sell": 20, "buy": 20 }
    },
  ]
}
```

## ⚙️ Configuration Options

Below is a concise description of each configuration option you may set per-bot (use these keys inside each `bots` entry in `examples/bots.json` / `profiles/bots.json`):

- **`name`**: string — optional friendly name for the bot. Used for logging and selection when calling CLI commands (e.g. `dexbot start my-bot`).
- **`active`**: boolean — if `false`, the bot is kept in the config but not started. Use this to keep templates in your file without running them.
- **`dryRun`**: boolean — when `true` the bot simulates orders and does not broadcast transactions on-chain. Use `false` only after you have verified your settings and secured keys.
- **`preferredAccount`**: string — the account name to use for on-chain operations; dexbot will prompt once for the master password and reuse it for all bots needing this value.
- **`assetA`**: string — human-friendly name or symbol of the base asset (the asset you are selling on a sell order). Example: `"BTC"`, `"BTS"`.
- **`assetB`**: string — human-friendly name or symbol of the quote asset (the asset you receive on a sell order). Example: `"USD"`, `"IOB.XRP"`.
- **`marketPrice`**: number | string — preferred market price. You may provide a numeric value (e.g. `42000`) or let the bot derive it by setting `"pool"` (use liquidity pool) or `"market"` (use order book/ticker). If omitted the runtime will attempt to derive it from `assetA`/`assetB`.
- **`minPrice`**: number | string — lower bound for allowed order prices. You may provide a concrete numeric value (e.g. `525`) or a multiplier string like `"5x"`. When given as a multiplier the runtime resolves it relative to `marketPrice` (e.g. `"5x"` -> `marketPrice / 5`). Choose values that meaningfully bracket your expected market range to avoid accidental order placement far from the current price.
- **`maxPrice`**: number | string — upper bound for allowed order prices. You may provide a concrete numeric value (e.g. `8400`) or a multiplier string like `"5x"`. When given as a multiplier the runtime resolves it relative to `marketPrice` (e.g. `"5x"` -> `marketPrice * 5`). Choose values that meaningfully bracket your expected market range to avoid accidental order placement far from the current price.
- **`incrementPercent`**: number — percent step between adjacent order price levels (e.g. `1` means 1% steps). Smaller values produce denser grids.
- **`targetSpreadPercent`**: number — target spread (in percent) around the market price that the grid should cover. The manager uses this to place buy/sell layers around the market.
- **`weightDistribution`**: object — `{ "sell": <number>, "buy": <number> }`. Controls order sizing shape. Values are the distribution coefficient (examples below):
  - Typical values: `-1` = Super Valley (more weight far from market), `0` = Valley, `0.5` = Neutral, `1` = Mountain (more weight near market), `2` = Super Mountain.
- **`botFunds`**: object — `{ "sell": <number|string>, "buy": <number|string> }`.
  - `sell`: amount of base asset allocated for selling (absolute like `0.1` or percentage string like `"100%"`).
  - `buy`: amount of quote asset allocated for buying (can be an absolute number like `10000` or a percentage string like `"50%"`).
  - `buy` refers to the quote-side (what you spend to buy base); `sell` refers to the base-side (what you sell). Provide human-readable units (not blockchain integer units).
  - If you supply percentages (e.g. `"50%"`) the manager needs `accountTotals` to resolve them to absolute amounts before placing orders; otherwise provide absolute numbers.
- **`activeOrders`**: object — `{ "sell": <integer>, "buy": <integer> }` number of sell/buy orders to keep active in the grid for each side.

## ⚙️ CLI & Running

### Single Bot (Direct)

You can run bots directly via `node dexbot.js` or using the `dexbot` CLI wrapper (installed via `npm link` or run with `npx dexbot`):

- `node dexbot.js` or `dexbot` — starts all active bots defined in `profiles/bots.json` (use `examples/bots.json` as a template).
- `dexbot start [bot_name]` — start a specific bot (or all active bots if omitted). Respects each bot's `dryRun` setting.
- `dexbot drystart [bot_name]` — same as `start` but forces `dryRun=true` for safe simulation.
- `dexbot stop [bot_name]` — mark a bot (or all bots) inactive; the config file is used the next time the process launches.
- `dexbot restart [bot_name]` — restart a bot and reset its order grid. This clears saved order state and regenerates the grid from scratch.
- `dexbot keys` — manage master password and keyring via `modules/chain_keys.js`.
- `dexbot bots` — open the interactive editor in `modules/account_bots.js` to create or edit bot entries.
- `dexbot --cli-examples` — print curated CLI snippets for common tasks.

`dexbot` is a thin wrapper around `./dexbot.js`. You can link it for system-wide use via `npm link` or run it with `npx dexbot`.

If any active bot requires `preferredAccount`, dexbot will prompt once for the master password and reuse it for subsequent bots.

### 🎯 PM2 Process Management (Recommended for Production)

For production use with automatic restart and process monitoring, use PM2:

#### Quick Start (All Bots)

```bash
# Start all active bots with PM2
node pm2.js

# Or via CLI
node dexbot.js pm2
```

This unified launcher handles everything automatically:
1. **BitShares Connection**: Waits for network connection
2. **PM2 Check**: Detects local and global PM2; prompts to install if missing
3. **Config Generation**: Creates `profiles/ecosystem.config.js` from `profiles/bots.json`
4. **Authentication**: Prompts for master password (kept in RAM only, never saved to disk)
5. **Startup**: Starts all active bots as PM2-managed processes with auto-restart

#### Single Bot via PM2

```bash
# Start a specific bot via PM2
node pm2.js <bot-name>
```

Same as `node pm2.js` but only starts the specified bot.

#### Individual Bot (Direct, without PM2)

```bash
# Run a single bot directly (prompts for password if not in environment)
node bot.js <bot-name>
```

#### PM2 Management Commands

After startup via `node pm2.js`:

```bash
# View bot status and resource usage
pm2 status

# View real-time logs from all bots (or specific bot)
pm2 logs
pm2 logs <bot-name>

# Stop all bots (or specific bot)
pm2 stop all
pm2 stop <bot-name>

# Restart all bots (or specific bot)
pm2 restart all
pm2 restart <bot-name>

# Delete all bots from PM2 (or specific bot)
pm2 delete all
pm2 delete <bot-name>
```

#### Configuration & Logs

Bot configurations are defined in `profiles/bots.json`. The PM2 launcher automatically:
- Filters only bots with `active !== false`
- Generates ecosystem config with proper paths and logging
- Logs bot output to `profiles/logs/<bot-name>.log`
- Logs bot errors to `profiles/logs/<bot-name>-error.log`
- Applies restart policies (max 13 restarts, 1 day min uptime, 3 second restart delay)

#### Security

- Master password is prompted interactively in your terminal
- Password passed via environment variable to bot processes (RAM only)
- Never written to disk or config files
- Cleared when process exits

## 🔐 Environment Variables

Control bot behavior via environment variables (useful for advanced setups):

- `MASTER_PASSWORD` - Master password for key decryption (set by `pm2.js`, used by `bot.js` and `dexbot.js`)
- `BOT_NAME` or `LIVE_BOT_NAME` - Select a specific bot from `profiles/bots.json` by name (for single-bot runs)
- `PREFERRED_ACCOUNT` - Override the preferred account for the selected bot
- `RUN_LOOP_MS` - Polling interval in milliseconds (default: 5000). Controls how often the bot checks for fills and market conditions
- `CALC_CYCLES` - Number of calculation passes for standalone grid calculator (default: 1)
- `CALC_DELAY_MS` - Delay between calculator cycles in milliseconds (default: 0)

Example - Run a specific bot with custom polling interval:
```bash
BOT_NAME=my-bot RUN_LOOP_MS=3000 node dexbot.js
```

## 🔄 How It Works

1. **Grid Creation**: Generates buy/sell orders in geometric progression.
2. **Order Sizing**: Applies weight distribution for optimal capital allocation.
3. **Activation**: Converts virtual orders to active state.
4. **Rebalancing**: Creates new orders from filled positions.
5. **Spread Control**: Adds extra orders if the spread becomes too wide.

## 📐 Order Calculation

The order sizing follows a compact formula:

```
y = (1-c)^(x*n) = order size
```

Definitions:
- `c` = increment (price step)
- `x` = order number (layer index; 0 is closest to market)
- `n` = weight distribution (controls how sizes scale across grid)

Weight distribution examples (set `n` via `weightDistribution`):
- `-1` = Super Valley (aggressive concentration towards the edge)
- `0` = Valley (orders increase linearly towards edge)
- `0.5` = Neutral (balanced distribution)
- `1` = Mountain (order increase linearly towards center)
- `2` = Super Mountain (aggressive concentration towards center)

## Output Example

```
===== ORDER GRID =====
Price           Type            State           Size
-----------------------------------------------
160000.00       sell            virtual         0.00555174
...orders...
40814.98        buy             virtual         386.55406154

===== FUNDS STATUS =====
Available: Buy 0.00 USD | Sell 0.00000000 BTC
Committed: Buy 8676.13 USD | Sell 0.12420407 BTC
```

## 🔍 Advanced Features

### ⚛️ Atomic Updates & Partial Order State Management
DEXBot handles filled orders and partial fills with atomic transactions across all operations:
- **Partial Fills**: Remaining portion tracked in `PARTIAL` state instead of cancellation
- **Atomic Moves**: Partial orders moved to new price levels in single transaction
- **Fill Detection**: Automatically detects filled orders via blockchain history or open orders snapshot
- **State Synchronization**: Grid state immediately reflects filled orders, proceeds credited to available funds
- **Batch Execution**: All updates submitted as **single atomic operation** (creates + updates + cancellations)
- **Consistency Guarantee**: Either all operations succeed or all fail - no partial blockchain states
- **No Manual Intervention**: Fully automatic fill processing, state updates, and rebalancing

This comprehensive fill handling ensures capital efficiency, eliminates orphaned orders or stuck funds, and guarantees consistency across all order state changes.

### ⏱️ Fill Deduplication
Fills are tracked with a 5-second deduplication window to prevent duplicate order processing. This ensures reliable fill detection even if the same fill event arrives multiple times.

### 🔢 Price Tolerance & Integer Rounding
The bot calculates price tolerances to account for blockchain integer rounding discrepancies. This ensures reliable matching of on-chain orders with grid orders despite minor precision differences.

### ⚡ Automatic Grid Recalculation via Threshold Detection
DEXBot automatically regenerates grid order sizes when market conditions or cached proceeds exceed configurable thresholds. This ensures orders remain optimally sized without manual intervention:

**Two Independent Triggering Mechanisms:**

1. **Cache Funds Threshold** (1% by default)
   - Monitors accumulated proceeds from filled orders (cached funds)
   - Triggers when cache ≥ 1% of allocated grid capital on either side
   - Example: Grid allocated 1000 BTS, cache reaches 15 BTS → ratio is 1.5% → triggers update
   - Updates buy and sell sides independently based on their respective ratios

2. **Grid Divergence Threshold** (1% by default)
   - Compares currently calculated grid with persisted grid state
   - Uses quadratic deviation metric: measures relative size differences squared: `Σ((calculated - persisted) / persisted)² / count`
   - Triggers when divergence metric × 100 > 1% threshold
   - Penalizes larger deviations more heavily (10% error contributes 0.01, 50% error contributes 0.25)
   - Example: If persisted orders are [100, 200, 150] and calculated are [100, 180, 160], metric is ~0.542%

**When Grid Recalculation Occurs:**
- After order fills and proceeds are collected
- On startup if cached state diverges from current market conditions
- Automatically without user action when either threshold is breached
- Buy and sell sides can update independently

**Benefits:**
- Keeps order sizing optimal as market volatility or proceeds accumulate
- Avoids manual recalculation requests for most scenarios
- Reduces grid staleness while minimizing unnecessary regenerations
- Maintains capital efficiency by redistributing proceeds back into orders

**Customization:**
You can adjust thresholds in `modules/constants.js`:
```javascript
GRID_REGENERATION_PERCENTAGE: 1,  // Cache funds threshold (%)
GRID_COMPARISON: {
    DIVERGENCE_THRESHOLD_Promille: 1  // Grid divergence threshold (promille = 0.1%)
}
```

### 💾 Persistent Grid & Price Caching
DEXBot intelligently caches grid calculations and order prices to avoid unnecessary recalculation:
- **Grid state persists** in `profiles/orders.json` across bot restarts
- **Order prices preserved** from the last successful synchronization
- **No recalculation on startup** if grid matches on-chain state
- **Automatic resync only when** on-chain state differs (fills, cancellations)

This optimization significantly reduces startup time and blockchain queries, especially for bots running 20+ orders.

### ✈️ Offline Filled Order Detection
The bot automatically detects orders that were filled while offline:
- **Compares persisted grid** with current on-chain open orders on startup
- **Identifies missing orders** (orders from grid that are no longer on-chain)
- **Marks them as FILLED** and credits proceeds to available funds
- **Immediate rebalancing** - replaces filled orders on next cycle
- **No manual intervention needed** - fully automatic synchronization

This ensures seamless resumption after being offline without missing fill proceeds.

### 📡 Periodic Blockchain Fetch
DEXBot can automatically refresh your blockchain account balances at regular intervals to keep order values up-to-date:
- **Default interval**: 240 minutes (4 hours)
- **Configurable**: Set `BLOCKCHAIN_FETCH_INTERVAL_MIN` in `modules/constants.js`
- **Automatic**: Runs in background without interrupting trading
- **Disable**: Set interval to `0` or an invalid value to disable periodic fetches

This ensures your bot's internal account balance tracking stays synchronized with the blockchain, especially useful for accounts that receive external transfers or participate in other trading activities.

Configure via environment variable or `modules/constants.js`:
```javascript
TIMING: {
    BLOCKCHAIN_FETCH_INTERVAL_MIN: 240  // fetch every 4 hours (0 = disabled)
}
```

### 📌 Trigger-File Grid Regeneration
Create a trigger file `profiles/recalculate.<bot-key>.trigger` to request immediate grid regeneration on the next polling cycle. This allows external scripts to request recalculation without restarting the bot.

Example:
```bash
touch profiles/recalculate.my-bot.trigger
```

### 🧮 Standalone Grid Calculator
Use the standalone calculator to dry-run grid calculations without blockchain interaction:

```bash
# Calculate grid 5 times with 1-second delays
CALC_CYCLES=5 CALC_DELAY_MS=1000 BOT_NAME=my-bot node -e "require('./modules/order/runner').runOrderManagerCalculation()"
```

Environment variables:
- `BOT_NAME` or `LIVE_BOT_NAME` - Select bot from `profiles/bots.json`
- `CALC_CYCLES` - Number of calculation passes (default: 1)
- `CALC_DELAY_MS` - Delay between cycles in milliseconds (default: 0)

## 📦 Modules

Below is a short summary of the modules in this repository and what they provide. You can paste these lines elsewhere if you need a quick reference.

### 🚀 Entry Points

- `dexbot.js`: Main CLI entry point. Handles single-bot mode (start, stop, restart, drystart) and management commands (keys, bots, --cli-examples). Includes full DEXBot class with grid management, fill processing, and account operations.
- `pm2.js`: Unified PM2 launcher. Orchestrates BitShares connection, PM2 check/install, ecosystem config generation from `profiles/bots.json`, master password authentication, and bot startup with automatic restart policies.
- `bot.js`: PM2-friendly per-bot entry point. Loads bot config by name from `profiles/bots.json`, authenticates via master password (from environment or interactive prompt), initializes DEXBot instance, and runs the trading loop.

### 🔧 Core Modules

- `modules/account_bots.js`: Interactive editor for bot configurations (`profiles/bots.json`). Prompts accept numbers, percentages and multiplier strings (e.g. `5x`).
- `modules/chain_keys.js`: Encrypted master-password storage for private keys (`profiles/keys.json`), plus key authentication and management utilities.
- `modules/chain_orders.js`: Account-level order operations: select account, create/update/cancel orders, listen for fills with deduplication, read open orders. Uses 'history' mode for fill processing which matches orders from blockchain events.
- `modules/bitshares_client.js`: Shared BitShares client wrapper and connection utilities (`BitShares`, `createAccountClient`, `waitForConnected`).
- `modules/btsdex_event_patch.js`: Runtime patch for `btsdex` library to improve history and account event handling.
- `modules/account_orders.js`: Local persistence for per-bot order-grid snapshots, metadata, cacheFunds, and pending proceeds (`profiles/orders.json`). Manages bot-specific files with atomic updates and race-condition protection.

### 📊 Order Subsystem (`modules/order/`)

Core order generation, management, and grid algorithms:

- `modules/constants.js`: Centralized order constants (types: `SELL`, `BUY`, `SPREAD`; states: `VIRTUAL`, `ACTIVE`, `PARTIAL`), timing constants, and `DEFAULT_CONFIG`.
- `modules/order/index.js`: Public entry point: exports `OrderManager` and `runOrderManagerCalculation()` (dry-run helper).
- `modules/order/logger.js`: Colored console logger and `logOrderGrid()` helper for formatted output.
- `modules/order/manager.js`: `OrderManager` class — derives market price, resolves bounds, builds and manages the grid, handles fills and rebalancing.
- `modules/order/grid.js`: Grid generation algorithms, order sizing, weight distribution, and minimum size validation.
- `modules/order/runner.js`: Runner for calculation passes and dry-runs without blockchain interaction.
- `modules/order/utils.js`: Utility functions (percent parsing, multiplier parsing, blockchain float/int conversion, market price helpers).

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## 📄 License

MIT License - see LICENSE file for details

## 🔗 Links

- [![Telegram](https://img.shields.io/badge/Telegram-%40DEXBot__2-26A5E4?logo=telegram&logoColor=white)](https://t.me/DEXBot_2)
- [![Website](https://img.shields.io/badge/Website-dexbot.org-4FC08D?logo=internet-explorer&logoColor=white)](https://dexbot.org/)
- [![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/froooze/DEXBot2)
- [![Awesome BitShares](https://camo.githubusercontent.com/9d49598b873146ec650fb3f275e8a532c765dabb1f61d5afa25be41e79891aa7/68747470733a2f2f617765736f6d652e72652f62616467652e737667)](https://github.com/bitshares/awesome-bitshares)
- [![Reddit](https://img.shields.io/badge/Reddit-r%2FBitShares-ff4500?logo=reddit&logoColor=white)](https://www.reddit.com/r/BitShares/)


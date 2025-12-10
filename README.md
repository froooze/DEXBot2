# DEXBot2

A sophisticated market making bot for the BitShares Decentralized Exchange (DEX), implementing optimized staggered order strategies for automated trading.

## Features

- **Staggered Order Grid**: Creates geometric order grids around market price for efficient market making.
- **Dynamic Rebalancing**: Automatically adjusts orders after fills to maintain optimal spread.

## Disclaimer

⚠️ Warning — Use At Your Own Risk

- This software is in alpha stage and provided "as‑is" without warranty.
- Always test configurations in `dryRun` mode.
- Secure your keys and secrets. Do not commit private keys or passwords to anyone — use `profiles/` for live configuration and keep it out of source control.
- The authors and maintainers are not responsible for losses.


## Installation

```bash
# Clone the repository and switch to folder
git clone https://github.com/froooze/DEXBot2.git
cd DEXBot2

# Install dependencies (if any)
npm install
```

## CLI & Running

### Single Bot (Direct)

Use the `dexbot` wrapper or run `node dexbot.js` directly:

- `node dexbot.js` — starts all active bots defined in `profiles/bots.json` (use `examples/bots.json` as a template).
- `dexbot start [bot_name]` — start a specific bot (or all active bots if omitted). Respects each bot's `dryRun` setting.
- `dexbot drystart [bot_name]` — same as `start` but forces `dryRun=true` for safe simulation.
- `dexbot stop [bot_name]` — mark a bot (or all bots) inactive; the config file is used the next time the process launches.
- `dexbot restart [bot_name]` — restart a bot (stop running process first if needed).
- `dexbot keys` — manage master password and keyring via `modules/chain_keys.js`.
- `dexbot bots` — open the interactive editor in `modules/account_bots.js` to create or edit bot entries.
- `dexbot --cli-examples` — print curated CLI snippets for common tasks.

`dexbot` is a thin wrapper around `./dexbot.js`. You can link it for system-wide use via `npm link` or run it with `npx dexbot`.

If any active bot requires `preferredAccount`, dexbot will prompt once for the master password and reuse it for subsequent bots.

### PM2 Process Management (Recommended for Production)

For production use with automatic restart and process monitoring, use PM2:

#### Quick Start

```bash
# Start all bots with PM2
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

#### Individual Bot

```bash
# Run a single bot directly (prompts for password if not in environment)
node bot.js <bot-name>
```

#### PM2 Management Commands

After startup via `node pm2.js`:

```bash
# View bot status and resource usage
pm2 status

# View real-time logs from all bots
pm2 logs

# View logs from specific bot
pm2 logs <bot-name>

# Stop all bots (but keep PM2 alive)
pm2 stop all

# Restart all bots
pm2 restart all

# Delete all bots from PM2
pm2 delete all
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

## Order Calculation

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

## Configuration

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

## Configuration Options

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

## How It Works

1. **Grid Creation**: Generates buy/sell orders in geometric progression.
2. **Order Sizing**: Applies weight distribution for optimal capital allocation.
3. **Activation**: Converts virtual orders to active state.
4. **Rebalancing**: Creates new orders from filled positions.
5. **Spread Control**: Adds extra orders if the spread becomes too wide.

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

## Modules

Below is a short summary of the modules in this repository and what they provide. You can paste these lines elsewhere if you need a quick reference.

### Entry Points

- `dexbot.js`: Main CLI entry point. Handles single-bot mode (start, stop, restart, drystart) and management commands (keys, bots, --cli-examples).
- `pm2.js`: Unified PM2 launcher. Orchestrates BitShares connection, PM2 check/install, ecosystem config generation, password authentication, and bot startup.
- `bot.js`: PM2-friendly per-bot entry point. Loads bot config, authenticates master password, initializes DEXBot, and runs the trading loop.

### Core Modules

- `modules/account_bots.js`: Interactive editor for bot configurations (`profiles/bots.json`). Prompts accept numbers, percentages and multiplier strings (e.g. `5x`).
- `modules/chain_keys.js`: Encrypted master-password storage for private keys, authenticate (`profiles/keys.json`), plus key management utilities.
- `modules/chain_orders.js`: Account-level order helpers: select account, create/update/cancel orders, listen for fills and read open orders.
- `modules/bitshares_client.js`: Shared BitShares client wrapper and helpers (`BitShares`, `createAccountClient`, `waitForConnected`).
- `modules/btsdex_event_patch.js`: Small runtime patch for `btsdex` history/account events (improves account history updates when available).
- `modules/account_orders.js`: Local persistence for per-bot order-grid snapshots and metadata (`profiles/orders.json`).

### Order Subsystem (`modules/order/`)

Core order generation, management, and grid algorithms:

- `modules/order/constants.js`: Order constants, grid limits, and `DEFAULT_CONFIG`.
- `modules/order/index.js`: Public entry point: exports `OrderManager` and `runOrderManagerCalculation()` (dry-run helper).
- `modules/order/logger.js`: Colored console logger and `logOrderGrid()` helper for formatted output.
- `modules/order/manager.js`: `OrderManager` class — derives market price, resolves bounds, builds and manages the grid, handles fills and rebalancing.
- `modules/order/grid.js`: Grid generation algorithms, order sizing, weight distribution, and minimum size validation.
- `modules/order/runner.js`: Runner for calculation passes and dry-runs without blockchain interaction.
- `modules/order/utils.js`: Utility functions (percent parsing, multiplier parsing, blockchain float/int conversion, market price helpers).

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - see LICENSE file for details

## Links

- [![Telegram](https://img.shields.io/badge/Telegram-%40DEXBot__2-26A5E4?logo=telegram&logoColor=white)](https://t.me/DEXBot_2)
- [![Website](https://img.shields.io/badge/Website-dexbot.org-4FC08D?logo=internet-explorer&logoColor=white)](https://dexbot.org/)
- [![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/froooze/DEXBot2)
- [![Awesome BitShares](https://camo.githubusercontent.com/9d49598b873146ec650fb3f275e8a532c765dabb1f61d5afa25be41e79891aa7/68747470733a2f2f617765736f6d652e72652f62616467652e737667)](https://github.com/bitshares/awesome-bitshares)
- [![Reddit](https://img.shields.io/badge/Reddit-r%2FBitShares-ff4500?logo=reddit&logoColor=white)](https://www.reddit.com/r/BitShares/)

## Disclaimer

This software is for educational and research purposes. Use at your own risk. Always test with small amounts and understand the risks of automated trading.

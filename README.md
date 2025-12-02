# DEXBot2

A sophisticated market making bot for the BitShares Decentralized Exchange (DEX), implementing optimized staggered order strategies for automated trading.

## Features

- **Staggered Order Grid**: Creates geometric order grids around market price for efficient market making.
- **Dynamic Rebalancing**: Automatically adjusts orders after fills to maintain optimal spread.

## Disclaimer

⚠️ Warning — Use At Your Own Risk

- This software is in very early stage and provided "as‑is" without warranty.
- Always test configurations in `dryRun` mode.
- Secure your keys and secrets. Do not commit private keys or passwords to anyone — use `profiles/` for live configuration and keep it out of source control.
- The authors and maintainers are not responsible for losses.


## Installation

```bash
# Clone the repository
git clone https://github.com/froooze/DEXBot2.git
cd DEXBot2

# Install dependencies (if any)
npm install
```

## CLI & Running

Use the `dexbot` wrapper or run `node dexbot.js` directly.

- `node dexbot.js` — starts all active bots defined in `profiles/bots.json` (use `examples/bots.json` as a template).
- `dexbot start [bot_name]` — start a specific bot (or all active bots if omitted). Respects each bot's `dryRun` setting.
- `dexbot drystart [bot_name]` — same as `start` but forces `dryRun=true` for safe simulation.
- `dexbot stop [bot_name]` — mark a bot (or all bots) inactive; the config file is used the next time the process launches.
- `dexbot restart [bot_name]` — restart a bot (stop running process first if needed).
- `dexbot keys` — manage master password and keyring via `modules/account_keys.js`.
- `dexbot bots` — open the interactive editor in `modules/account_bots.js` to create or edit bot entries.
- `dexbot --cli-examples` — print curated CLI snippets for common tasks.

`dexbot` is a thin wrapper around `./dexbot.js`. You can link it for system-wide use via `npm link` or run it with `npx dexbot`.

If any active bot requires `preferredAccount`, dexbot will prompt once for the master password and reuse it for subsequent bots.

## Order Calculation

The order sizing follows a compact formula:

```
y = (1-c)^(x*n) = order size
```

Definitions:
- `c` = increment (price step percentage / spacing factor)
- `x` = order number (layer index; 0 is closest to market)
- `n` = weight distribution (controls how sizes scale across layers)

Weight distribution examples (set `n` via `weightDistribution`):
- `-1` = Super Valley (largest orders farthest from market)
- `0` = Valley (orders decrease linearly outward)
- `0.5` = Neutral (balanced distribution)
- `1` = Mountain (largest orders closest to market)
- `2` = Super Mountain (aggressive concentration near market)

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
      "minPrice": 525,
      "maxPrice": 8400,
      "incrementPercent": 1,
      "targetSpreadPercent": 5,
      "weightDistribution": { "sell": 1, "buy": 2 },
      "botFunds": { "buy": "100%", "sell": "100%" },
      "activeOrders": { "buy": 10, "sell": 10 }
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
- **`weightDistribution`**: object — `{ "sell": <number>, "buy": <number> }`. Controls order sizing shape. Use this to shape capital allocation across layers; smaller/negative values push size to outer layers, larger positive values concentrate near the market. 
- **`botFunds`**: object — `{ "buy": <number|string>, "sell": <number|string> }`.
  - `buy`: amount of quote asset allocated for buying (can be an absolute number like `10000` or a percentage string like `"50%"`).
  - `sell`: amount of base asset allocated for selling (absolute like `0.1` or percentage string like `"100%"`).
  - `buy` refers to the quote-side (what you spend to buy base); `sell` refers to the base-side (what you sell). Provide human-readable units (not blockchain integer units).
  - If you supply percentages (e.g. `"50%"`) the manager needs `accountTotals` to resolve them to absolute amounts before placing orders; otherwise provide absolute numbers.
- **`activeOrders`**: object — `{ "buy": <integer>, "sell": <integer> }` number of buy/sell orders to keep active in the grid for each side.
- **`accountTotals`**: object (optional runtime) — `{ "buy": <number>, "sell": <number> }`. Real human-readable totals of the quote (buy) and base (sell) balances used to resolve percentage `botFunds`. Provide these before initialization when using percentage-based `botFunds`.
- **`timeoutMs`**: number (optional) — request timeout in milliseconds for client calls (where supported). Useful to tune network/DB timeouts.
For testing: if you want an explicit calculation pass while a bot is running, the `modules/order` runner or the OrderManager API can trigger the same logic without broadcasting orders.


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

- `modules/account_bots.js`: Interactive editor for bot configurations (`profiles/bots.json`). Prompts accept numbers, percentages and multiplier strings (e.g. `5x`).
- `modules/account_keys.js`: Encrypted master-password storage for private keys (`profiles/keys.json`), plus key management utilities.
- `modules/account_orders.js`: Account-level order helpers: authenticate/select account, create/update/cancel orders, listen for fills and read open orders.
- `modules/bitshares_client.js`: Shared BitShares client wrapper and helpers (`BitShares`, `createAccountClient`, `waitForConnected`).
- `modules/bot_instance.js`: PM2-friendly per-bot runner that boots an `OrderManager` for a chosen bot config.
- `modules/btsdex_event_patch.js`: Small runtime patch for `btsdex` history/account events (improves account history updates when available).
- `modules/indexdb.js`: Local persistence for per-bot order-grid snapshots and metadata (`profiles/orders.json`).
- `modules/order/`: Core order subsystem (see sub-items below).
  - `modules/order/constants.js`: Order constants and `DEFAULT_CONFIG`.
  - `modules/order/index.js`: Public entry: exports `OrderManager` and `runOrderManagerCalculation()` (dry-run helper).
  - `modules/order/logger.js`: Colored console logger and `logOrderGrid()` helper.
  - `modules/order/manager.js`: `OrderManager` class — derives market price, resolves bounds, builds and manages the grid.
  - `modules/order/order_grid.js`: Grid generation and sizing algorithms.
  - `modules/order/price.js`: Helpers to derive market price from pool/market/ticker.
  - `modules/order/runner.js`: Runner for calculation passes and dry-runs.
  - `modules/order/utils.js`: Utility functions (percent parsing, multiplier parsing, blockchain float/int conversion).



## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - see LICENSE file for details

## Links

- https://deepwiki.com/froooze/DEXBot2
- https://t.me/DEXBot_2
- https://dexbot.org/

## Disclaimer

This software is for educational and research purposes. Use at your own risk. Always test with small amounts and understand the risks of automated trading.

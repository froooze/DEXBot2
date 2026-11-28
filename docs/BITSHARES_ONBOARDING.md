# BitShares Onboarding for DEXBot2

This tutorial walks you through everything you need before your first DEXBot2
trade, assuming you are new to BitShares and the Linux terminal:

1. What BitShares is and how its markets work
2. Creating and funding a BitShares account
3. Understanding account keys — and which one DEXBot2 needs
4. Importing your key into DEXBot2
5. Creating a bot configuration and activating the market adapter
6. Running a dry run and checking the result
7. Going live
8. Troubleshooting first-run mistakes

**Prerequisite:** DEXBot2 is installed. See the "Installation" section of the
root [README](../README.md#-installation) for installation options
(`npm i -g dexbot` or clone + `npm install` + `npm link`).

---

## 1. What is BitShares?

BitShares is a **decentralized financial blockchain** — its flagship use case is
a fully on-chain DEX, but the chain itself is a general financial platform
(accounts with multi-signature authority, user-issued assets, market-pegged
assets, liquidity pools, prediction markets, and a peer-to-peer credit system).
Everything on the DEX is on-chain: order books, matching, settlement, and
balances. There is no registration wall, no KYC, and no intermediary holding
your funds. See the [BitShares whitepaper](https://bitshares.github.io/docs/#/whitepaper)
for the full vision.

- The native asset is **BTS**. It pays trading fees and backs most
  market-pegged assets.
- Markets are pairs such as **XBTSX.USDT / BTS** or **HONEST.USD / BTS**.
- **Gateway assets** (like `XBTSX.USDT`) are issued by a gateway operator that
  holds the real asset (here, USDT) off-chain and represents it 1:1 on the
  chain. Trading them works like any other pair.
- A **market-pegged asset (MPA)**, like `HONEST.USD`, tracks the value of an
  external asset through on-chain price feeds and is collateralized by BTS.
  Trading it works like any other pair — the price feeds just keep it pegged.
- A **peer-to-peer (P2P) credit system** — on-chain lending between accounts,
  no bank or broker in the middle. Lenders offer assets at interest through **credit
  offers**; borrowers pledge collateral and repay (or auto-repay) on expiry.
  DEXBot2 can borrow MPAs and take credit offers for you — see
  [MPA and Credit Usage](MPA_CREDIT_USAGE.md#which-section-do-i-need).

DEXBot2 is a **grid trading bot** for these pairs: it places a ladder of buy
and sell orders around a reference price and profits as price oscillates
through the grid.

---

## 2. Create and fund a BitShares account

### 2.1 Register an account

DEXBot2 does **not** create accounts — the account must exist on-chain before
the bot can resolve it. Any wallet can register one; pick whichever UI suits
you:

1. Open one of the account-creation pages and choose to create a new account:
   - **bts.exchange (hosted BitShares UI)** —
     [bts.exchange/#/create-account/](https://bts.exchange/#/create-account/)
   - **XBTS DEX (fast on-chain registration)** —
     [trade.xbts.io/accounts](https://trade.xbts.io/accounts). XBTS offers
     "quick registration" of a named account directly on-chain — no KYC, no
     email or SMS verification; a secret phrase is shown once, so save it.
2. Pick an account name. It must be globally unique and consist of lowercase
   letters, digits, and dashes (e.g. `my-grid-bot`).
3. Registration costs a small BTS fee; with **XBTS DEX** the exchange pays it
   for you, so signup is effectively free. Becoming a **Lifetime Member (LTM)**
   saves 80% on all blockchain fees and allows registering **premium (short)
   account names**.
4. Save the **master password / secret phrase / backup** in a safe place. It is
   the only way to recover or export your keys.

> Once your account name resolves on-chain (it has a `1.2.x` account id),
> DEXBot2 can use it — including in dry-run mode.

### 2.2 Fund the account

The bot needs the account to hold **both assets of the pair** you want to trade
(one side to buy, one side to sell), plus a little BTS for trading fees.

- Buy BTS on any exchange that lists it and withdraw it to your BitShares
  account name (the wallet accepts the account name as the deposit address).
- To trade `XBTSX.USDT / BTS`, either deposit `XBTSX.USDT` directly, or swap
  some BTS into `XBTSX.USDT` inside the wallet.

Start with **small amounts** on your first bot. Grid bots allocate capital
across many grid levels, so a few hundred units of the pair is plenty to learn
with.

### 2.3 Gateways and supported assets

Two sources of on-chain assets: **gateways** issue assets representing real
coins from other blockchains, and **market-pegged assets (MPAs)** are backed by
BTS collateral and tracked to an external reference by on-chain price feeds.
The main gateway operators are:

#### ioxbank — [https://www.ioxbank.com/](https://www.ioxbank.com/)

Instant gateway settling deposits/withdrawals as soon as the external chain
confirms them. No KYC, no limits, 0% maker/taker market fee.

| Asset | Min. deposit | Notes |
| :--- | :--- | :--- |
| **IOB.XRP** | 10 XRP | Instant gateway |
| **IOB.XLM** | 50 XLM | Instant gateway |

#### XBTS DEX — [https://xbts.io](https://xbts.io)

XBTS issues **XBTSX.** assets across multiple networks (native, ERC-20,
BEP-20, TON). The noteworthy, actively traded ones:

| Asset | Networks | Asset | Networks |
| :--- | :--- | :--- | :--- |
| XBTSX.BTC | native / BEP-20 | XBTSX.USDT | ERC-20 / BEP-20 / TON |
| XBTSX.ETH | native / ERC-20 / BEP-20 | XBTSX.USDC | ERC-20 / BEP-20 |
| XBTSX.BNB | BEP-20 | XBTSX.XAUT (gold) | ERC-20 |
| XBTSX.SOL | BEP-20 | XBTSX.DAI | BEP-20 |
| XBTSX.AVAX | BEP-20 | XBTSX.LTC | native |
| XBTSX.DOGE | native / BEP-20 | | |
| XBTSX.STH | native / ERC-20 / BEP-20 / TON | XBTSX.BCH | native / BEP-20 |
| XBTSX.GRAM | native / TON | XBTSX.ETC | native / BEP-20 |
| XBTSX.HIVE | native | XBTSX.ZEC | native / BEP-20 |
| XBTSX.PEPE | ERC-20 | XBTSX.MANA | ERC-20 / BEP-20 |
| XBTSX.SHIB | BEP-20 | | |

The full live list (100 assets across 6 networks, with per-asset deposit and
withdrawal status) is at [xbts.io/assets](https://xbts.io/assets).

#### HONEST.Assets (MPA)

HONEST.Assets are **market-pegged assets** collateralized by BTS with price
feeds published by the HONEST committee. They behave like any other pair for
grid trading, and can be borrowed/shorted with a collateral position:

- **Crypto:** HONEST.BTC, HONEST.ETH, HONEST.LTC, HONEST.XRP, HONEST.SOL,
  HONEST.XLM, HONEST.DOT, HONEST.ADA, HONEST.ATOM, HONEST.EOS, ...
- **Fiat:** HONEST.USD, HONEST.EUR, HONEST.CNY, HONEST.GBP, HONEST.JPY,
  HONEST.KRW, HONEST.RUB
- **Commodities:** HONEST.XAU, HONEST.XAG
- **Reference bridge:** HONEST.MONEY (prices HONEST pairs against BTS)

See `claw/skills/margin-trading/references/honest-asset-list.md` for the full
inventory (46 MPAs incl. inverse `*SHORT` tokens) and
`claw/skills/margin-trading/references/honest-assets.md` for fee structure,
maintenance collateral ratio, and feed behavior.

#### Classic bitAssets (MPA)

The original BitShares MPAs from the core genesis
([bitshares-core](https://github.com/bitshares/bitshares-core)) — still the
reference MPA set on the network. Same mechanics as HONEST.Assets:

| bitAsset | Tracks | bitAsset | Tracks |
| :--- | :--- | :--- | :--- |
| bitUSD | US dollar | bitBTC | Bitcoin |
| bitCNY | Chinese yuan | bitGOLD | Gold (1 oz) |
| bitEUR | Euro | bitSILVER | Silver (1 oz) |
| bitGBP | Pound sterling | bitJPY | Japanese yen |
| bitRUB | Russian ruble | bitKRW | South Korean won |
| bitTRY | Turkish lira | bitHKD | Hong Kong dollar |
| bitSGD | Singapore dollar | bitSEK | Swedish krona |
| bitCAD | Canadian dollar | bitAUD | Australian dollar |
| bitCHF | Swiss franc | bitNZD | New Zealand dollar |

Trade them like any other pair (e.g. `bitUSD / BTS`); borrowable/shortable with
a collateral position just like the HONEST set.

---

## 3. Understand your account keys

Every BitShares account has three authority keys:

| Key | Can do | Needed by DEXBot2? |
| :--- | :--- | :--- |
| **Owner** | Everything — full account control, recovery | No (too powerful to store in a bot) |
| **Active** | Trade, vote, transfer | **Yes — this is the one** |
| **Memo** | Encrypt/decrypt private messages | No |

You may also see a **"login" key** in some wallets. It is a separate key used
for logging into third-party services and **cannot sign trades**. This is the
single most common first-run mistake.

### What DEXBot2 needs

- The **active** private key of your account, exported from your wallet in
  **WIF format** — a string of 51/52 characters starting with `5`.
- `PVT_*` and 64-hex formats are also accepted, but WIF is what most wallets
  export.
- The stored key is matched to the account by the **account name** you type in
  `dexbot key`, so the name must match your config exactly.

> `dexbot key` only checks that the string looks like a valid private key — it
> does **not** verify that the key belongs to the account. A wrong key is
> accepted at import and only fails later, when the chain rejects your signed
> orders. Double-check that the key you import is the account's **active** key.

### Security rules

- Never share private keys or your master password.
- Store the **owner** key offline. Only import the **active** key into the bot.
- If you ever leak a key, rotate it in the wallet and update the bot.

### Where to find your active key

The easiest way to get the **active** private key (WIF) is the reference wallet
**bts.exchange**:

> Burger menu → **Advanced** → **Permissions** → **Active permissions** → click
> the **key icon** next to the active key → in the popup click **show** → enter
> your wallet password → the WIF private key is displayed.

Other wallets hide the key behind encryption (trade.xbts.io, BeetVault) or a
connected wallet app (Astro UI). Fallback in all cases: the **master password /
secret phrase** — the active key is deterministically derived from it and can
be regenerated in any wallet that supports password login, most conveniently
in bts.exchange.

---

## 4. Import your key into DEXBot2

Run the key manager:

```bash
dexbot key
```

1. Set a **master password** the first time (used to encrypt all stored keys).
2. Choose **1. Add key**.
3. Enter the account name exactly as registered.
4. Paste the **active private key (WIF)**.
5. Repeat for any additional accounts.

Keys are stored encrypted in `keys.json` inside your profiles directory
(`~/.config/dexbot2/profiles` by default — see
[Where are the logs?](#where-are-the-logs) for how this resolves) and held in
RAM by the credential daemon while the bot runs. See
[CREDENTIAL_SECURITY.md](CREDENTIAL_SECURITY.md) for how this is protected.

---

## 5. Create a bot configuration

Run the interactive configurator:

```bash
dexbot bot
```

Key answers for your first bot:

- **Name** — anything you like, e.g. `my-first-bot`.
- **assetA / assetB** — the pair, e.g. `xbtsx.usdt` and `bts`
  (asset names are case-insensitive; the wallet shows them in uppercase).
- **Account** — the account you imported in the previous step.
- **startPrice** — leave the default (`"pool"` reads the liquidity-pool price,
  `"book"` reads the order-book mid price, or a number for a fixed anchor). If
  your pair has no native pool, set **poolRef** to a pool id such as `1.19.48`.
- **Active / Dry run / adapter flags** — boolean prompts accept `y`, `yes`, or
  `true` and `n`, `no`, or `false`; Enter keeps the shown default.

Keep all other defaults — they are sensible. Prefer **relative values** where
possible: dynamic price sources like `"pool"` / `"book"` for `startPrice`,
`"ama"` for `gridPrice`, `"2x"`-style multipliers for `minPrice` / `maxPrice`,
and percentage funds (`botFunds`) — they rescale automatically as the market
moves; fixed numbers do not. The editor highlights this live: **green** =
relative/dynamic (recommended), **red** = fixed absolute value.

The only things worth tuning later:

- `targetSpreadPercent` — controls profit room per cycle
  (≈ `spread - increment - fees`) but trades less often when wider.
- `incrementPercent` — order steps and order size: smaller increments create
  more grid levels and smaller orders, larger increments fewer levels and
  larger orders. Smaller increments cycle faster — higher profits, but more
  fees.
- `weightDistribution` — advanced order sizing per side
  (`{ "sell": …, "buy": … }`, range `-1`–`2`): higher = more funds in orders
  near the market price, lower = shifted toward the grid edge. `-1` =
  super-valley, `0` = valley, `0.5` = neutral, `1` = mountain (default),
  `2` = super-mountain — shown live in the editor. Leave the default
  `{ "sell": 1.0, "buy": 1.0 }` for your first bot.
- `minPrice` / `maxPrice` — grid bounds. Once AMA is active, tighten them
  around the market's maximum expected volatility instead of a wide range.
  Use `dexbot tv <bot>` to see the grid range and AMA recentering against
  real candles.

See the "Recommended Bot Setup" section of the
[README](../README.md#recommended-bot-setup).

### Editing a running bot

You can re-run `dexbot bot` and save while the bot runs:

- **Live automatically (~1 min, no reload needed)** — order counts,
  reserves, funds, and weights. The bot picks these up on its own.
- **Grid geometry** — run `dexbot reset <bot>` (or `dexbot reload` to
  reload everything at once).
- **Market/account changes** — run `dexbot reload` (reloads the runtime
  without logging you out; a full `restart` also works).

> `dexbot reload` / `restart` / `stop` are **whole-runtime** in the default
> monolithic mode: every active bot shares one worker process, so passing a bot
> name (e.g. `dexbot reload <bot>`) is validated and then applied to the whole
> runtime with a notice. To act on a single bot, start with `dexbot start
> --isolated` first. `delete` is whole-runtime and rejects a bot name; `status`
> is whole-runtime and validates, then ignores, one.

The editor prints exactly which group your save falls into every time it
saves, so you always know whether anything else is needed.

### Activate the market adapter

New bots anchor on `gridPrice: "ama3"`, but AMA pricing only goes live once
the per-bot adapter `Price` flag is on: run `dexbot bot`, choose
`2) Modify bot`, pick the bot, then `6) Adapter` and set **Price** to yes
(`y` / `yes` / `true` all count; Enter keeps the current value). Without it
the adapter still computes state but live output stays in dry-run.

To change how closely the grid center tracks the market, set `gridPrice` in
`3) Price`: `"ama1"` reacts fastest, `"ama4"` is the slowest and steadiest
(higher numbers smooth more), and `"ama"` uses the pair's default preset.

The three flags are stored per bot in `profiles/market_adapter_whitelist.json`:

- **Price** — live grid files and recalc triggers (`ama: true`)
- **Weight** — dynamic buy/sell weights (opt-in)
- **AMA-Slope** — range scaling (opt-in; stays off until enabled here)

The adapter is started/stopped automatically when active AMA bots exist.

---

## 6. Run a dry run and check the result

```bash
dexbot start --dryrun
```

Dry-run builds and simulates the whole grid without broadcasting anything —
useful to confirm your config before going live. It still needs a **real
registered account** and stored key, because the bot reads account data from
the chain.

`dexbot start` runs in the **background**; use `--foreground` to watch output
live:

```bash
dexbot start --dryrun --foreground   # stop with Ctrl+C
```

### Checking status and logs

| What | How |
| :--- | :--- |
| Runtime status | `dexbot stat` |
| Live output | `dexbot start --foreground` (stop with Ctrl+C) |
| Logs | `<profiles>/logs/` — runtime `dexbot.log`, per-bot `<bot>.log` (see [Where are the logs?](#where-are-the-logs)) |
| Clear logs | `dexbot clear` |

See [LOGGING.md](LOGGING.md) for the full logging reference.

---

## 7. Go live

When the dry run looks correct:

1. Make sure the account holds both pair assets (plus some BTS for fees).
2. Start:

   ```bash
   dexbot start
   ```

3. Watch the first cycles and verify orders appear on-chain (in your wallet's
   order book for the pair, or with `dexbot stat`).

Stop the runtime with `dexbot stop`. `dexbot restart` restarts it.

---

## Troubleshooting first-run mistakes

### "`npm link` says permission denied / `EACCES`"

Don't use `sudo npm link` — it creates root-owned files that break later
builds and runs. With a user-owned Node (nvm, Homebrew) `npm link` needs no
root. Check first:

```bash
which node npm       # both should point at your user install
npm prefix -g        # must be a directory you own
```

- **System Node (`/usr/bin`, `/usr/local/bin`)?** Redirect npm to your home
  directory instead of using `sudo`:

  ```bash
  mkdir -p ~/.npm-global
  npm config set prefix ~/.npm-global
  # add ~/.npm-global/bin to PATH, then re-open the shell
  ```

  Packages installed before the redirect stay in the old prefix — reinstall
  what you need (`npm i -g dexbot`) and check `which dexbot` points under
  `~/.npm-global`.

- **Already ran `sudo npm link`?** Undo it and relink as yourself:

  ```bash
  sudo npm unlink -g dexbot
  sudo chown -R "$(whoami)" <path-to-your-DEXBot2-checkout>
  cd <path-to-your-DEXBot2-checkout>
  npm install && npm link
  ```

Check with `dexbot --help`.

### "npm says it blocked dexbot's install scripts (`prepare`)"

npm 12+ no longer runs lifecycle scripts of installed packages unless they
are allowlisted (supply-chain hardening,
[npm/rfcs#868](https://github.com/npm/rfcs/blob/master/text/0868-allow-scripts.md)).
With `npm link` you'll see `npm warn install-scripts ... blocked` listing
dexbot's `prepare`: link adds your checkout to the **global** install tree as
a `file:` dependency — npm treats it like any third-party package and blocks
its scripts. The warning's own advice (`npm install-scripts ls` / `approve`)
is a dead end here: in your project the checkout is the project root, which
npm deliberately never lists or approves. Don't chase it.

A plain `npm install` is **not** gated — it runs the project's own `prepare`
directly, so the correct from-source order is:

```bash
cd <path-to-your-DEXBot2-checkout>
npm install      # runs prepare → builds dist/
npm link         # a blocked prepare here is harmless
```

If you skipped the install (or want to be sure), run `npm run build`. Bins
are never gated, so once `dist/` exists the linked `dexbot` works.

### "`Unknown command: dexbot` right after installing/linking"

- **The link or build silently failed** — see the two entries above.
  `which dexbot` must point into a directory you own (not `/usr/bin` or
  `/usr/local/bin`).
- **The shell hasn't noticed the new command yet.** Open a fresh shell
  (`exec fish`, `exec bash`, or reopen the terminal), or run `hash -r` in
  bash.

### "I imported my key but the bot's orders are rejected"

You imported the wrong key type. DEXBot2 needs the account's **active**
(trading) private key — a *login* or *memo* key cannot sign trades. Export the
**active** key from your wallet and re-import it with `dexbot key` → *Modify
key*.

### "Unable to resolve account '...' on the BitShares blockchain"

The account name is not registered on-chain (or is misspelled). Register the
account first (see [Register an account](#21-register-an-account)). This error
appears even in dry-run mode because the bot reads account data from the chain.

### "No signing key found for account '...'"

No key is stored for that account, or the stored key does not match the
account's authority. Add the correct **active** key with `dexbot key` and make
sure the account name matches your bot config.

### "Where is my bot? / Ctrl+C doesn't do what I expected"

`dexbot start` runs in the **background** and returns to the shell — the bot
keeps running. Check it with `dexbot stat`, watch it with `--foreground`, or
read the logs under `<profiles>/logs/` (see below).

### "Where are the logs?"

All log files live under `<profiles>/logs/`, where `<profiles>` is your
profiles directory: **`~/.config/dexbot2/profiles` by default for all
installs** (Windows: `%USERPROFILE%\.config\dexbot2\profiles`). A source
checkout that already contains a populated `profiles/` folder keeps using
`<repo>/profiles/logs/`, and the `DEXBOT_PROFILE_ROOT` environment variable
overrides the location entirely.

| File | Contents |
| :--- | :--- |
| `dexbot.log` / `dexbot-error.log` | Runtime (monolithic daemon) stdout/stderr |
| `<bot>.log` / `<bot>-error.log` | Per-bot output |
| `dexbot-cred.log` | Credential daemon |
| `dexbot-adapter.log` / `dexbot-adapter-error.log` | Market adapter managed by the runtime |
| `market_adapter.log` | Standalone adapter mode |
| `dexbot-update.log` / `dexbot-update-error.log` | Auto-updater |
| `daemon-audit.jsonl` | Credential daemon audit trail (`sign_denied` and friends) |

See [LOGGING.md](LOGGING.md) for log levels, rotation, and JSON output.
`dexbot clear` empties the logs directory wherever it resolves: every `*.log`, rotated
`*.log.N` and `*.jsonl*` — so the credential-daemon audit trail
(`daemon-audit.jsonl` and its rotated siblings) goes too; the preview names it.
Stop the runtime first (`dexbot stop`): a running daemon keeps writing to the
unlinked files, so the space is only freed on restart, and the scripts warn you
when they detect a live runtime. Siblings: `clear-orders`, `clear-market-adapter`,
`clear-all`.

### "I forgot the master password"

The master password is never stored — it only exists in your head. It encrypts
all the private keys in `keys.json` (inside your profiles directory), and
there is **no recovery path**: changing it requires the current password, so a
forgotten one means the stored keys can no longer be decrypted. Re-import your
keys:

1. Delete `keys.json` from your profiles directory (and stop any running
   bot/daemon that holds it open).
2. Run `dexbot key` again — it will create a fresh vault.
3. Import your account keys again (see [Import your key into DEXBot2](#4-import-your-key-into-dexbot2)).

You do **not** need the old password to recover the keys themselves — export the
**active** WIF from your wallet and re-import it (see section 3). From then on,
store the new master password somewhere safe.

### "My bot fails to start on Node 18/20 or with `ERR_REQUIRE_ESM`"

DEXBot2 is built on native ES modules and **requires Node.js >= 22.12**. On
older versions the entry scripts throw `ERR_REQUIRE_ESM` at boot. Check your
version and upgrade:

```bash
node --version        # must print v22.12.0 or newer
```

Install the latest Node 22 LTS (or newer) from
[nodejs.org](https://nodejs.org), then restart the bot.

### "The bot fails to start: `startPrice could not be derived`"

DEXBot2 needs a price to build the grid. With `startPrice` set to `"pool"` or
`"book"`, it reads a **live price from the chain** — so the pair must actually
have one:

- **`"pool"`** requires a matching **liquidity pool** on chain for the pair.
- **`"book"`** requires an active **order book** for the pair.

If the pair has neither, set a fixed numeric `startPrice` instead (or a
`poolRef` pointing at a real pool id — see section 5).

### "My orders get rejected / the account has no BTS"

Every trade on BitShares costs a small fee paid in **BTS**. If the account has
no (or too little) BTS balance, broadcasts are rejected by the chain even when
the pair assets are funded. Make sure the account holds enough BTS to cover
trading fees before going live (see [Fund the account](#22-fund-the-account)).

---

## Interaction

Different ways to interact with your BitShares account:

- [bts.exchange](https://bts.exchange) — Hosted reference wallet
- [XBTS Exchange](https://trade.xbts.io/) — Hosted exchange and wallet
- [Mobile App](https://github.com/bitshares/bitshares-mobile-app/releases) — Mobile Android app
- [Astro UI](https://github.com/BTS-CM/astro-ui/releases) — Local UI
- [BeetVault](https://github.com/beetapp/BeetVault) — Local Key Manager
- [BitShares Wallet](https://pi314x.github.io/bitshares-wallet-browser-extension) — Browser Extension
- [Paper Wallet](https://paperwallet.bitshares.eu/) — Print Wallet

---

## Further reading

- [Documentation Index](README.md) — full docs hub: architecture, lifecycle, workflows, and reference docs
- [Market Adapter](../market_adapter/README.md#quick-start) — AMA pricing and grid tuning
- [MPA and Credit Usage](MPA_CREDIT_USAGE.md#which-section-do-i-need) — borrowing and credit offer workflows

## Link Collection

- [![Telegram](https://img.shields.io/badge/Telegram-%40DEXBot__2-26A5E4?logo=telegram&logoColor=white)](https://t.me/DEXBot_2)
- [![Website](https://img.shields.io/badge/Website-dexbot.org-4FC08D?logo=internet-explorer&logoColor=white)](https://dexbot.org/)
- [![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/froooze/DEXBot2)
- [![Awesome BitShares](https://camo.githubusercontent.com/9d49598b873146ec650fb3f275e8a532c765dabb1f61d5afa25be41e79891aa7/68747470733a2f2f617765736f6d652e72652f62616467652e737667)](https://github.com/bitshares/awesome-bitshares)
- [![Reddit](https://img.shields.io/badge/Reddit-r%2FBitShares-ff4500?logo=reddit&logoColor=white)](https://www.reddit.com/r/BitShares/)

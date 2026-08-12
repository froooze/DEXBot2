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

**Prerequisite:** DEXBot2 is installed. See the root [README](../README.md)
for installation options (`npm i -g dexbot` or clone + `npm install`).

---

## 1. What is BitShares?

BitShares is a **decentralized financial blockchain** — its flagship use case is
a fully on-chain DEX, but the chain itself is a general financial platform
(accounts with multi-signature authority, user-issued assets, market-pegged
assets, liquidity pools, prediction markets). Everything on the DEX is
on-chain: order books, matching, settlement, and balances. There is no
registration wall, no KYC, and no intermediary holding your funds. See the
[BitShares whitepaper](https://bitshares.github.io/docs/#/whitepaper) for the
full vision.

- The native asset is **BTS**. It pays trading fees and backs most
  market-pegged assets.
- Markets are pairs such as **XBTSX.USDT / BTS** or **HONEST.USD / BTS**.
- **Gateway assets** (like `XBTSX.USDT`) are issued by a gateway operator that
  holds the real asset (here, USDT) off-chain and represents it 1:1 on the
  chain. Trading them works like any other pair.
- A **market-pegged asset (MPA)**, like `HONEST.USD`, tracks the value of an
  external asset through on-chain price feeds and is collateralized by BTS.
  Trading it works like any other pair — the price feeds just keep it pegged.

DEXBot2 is a **grid trading bot** for these pairs: it places a ladder of buy
and sell orders around a reference price and profits as price oscillates
through the grid.

---

## 2. Create and fund a BitShares account

### 2.1 Register an account

DEXBot2 does **not** create accounts — the account must exist on-chain before
the bot can resolve it. Registration is the same on-chain operation from any
wallet, so pick whichever UI suits you:

1. Open one of the account-creation pages and choose to create a new account:
   - **bts.exchange (hosted BitShares UI)** —
     [bts.exchange/#/create-account/](https://bts.exchange/#/create-account/)
   - **XBTS DEX (fast on-chain registration)** —
     [trade.xbts.io/accounts](https://trade.xbts.io/accounts). XBTS offers
     "quick registration" of a named account directly on-chain — no KYC, no
     email or SMS verification; a secret phrase is shown once, so save it.
2. Pick an account name. It must be globally unique and consist of lowercase
   letters, digits, and dashes (e.g. `my-grid-bot`).
3. Registration costs a small fee in BTS. With **XBTS DEX** the exchange pays
   the blockchain registration fee for you, so signup is effectively free. If
   you become a **Lifetime Member (LTM)** you save 80% on all blockchain fees
   and can register **premium (short) account names**.
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

On-chain assets come from two sources: **gateways** issue assets that represent
real coins from other blockchains, and **market-pegged assets (MPAs)** are
backed by BTS collateral and tracked to an external reference by on-chain price
feeds. The main gateway operators are:

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

The original BitShares market-pegged assets, defined in the core genesis
([bitshares-core](https://github.com/bitshares/bitshares-core) genesis) and
still the reference MPA set on the network. Same mechanics as HONEST.Assets:
BTS-collateralized, tracked to an external reference by on-chain price feeds.

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

Trading bitAssets works like any other pair — e.g. `bitUSD / BTS` — and they
can be borrowed/shorted with a collateral position just like the HONEST set.

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

Other wallets either hide the key behind encryption (trade.xbts.io, BeetVault)
or keep keys in a connected wallet app (Astro UI). In those cases the fallback
is always your **master password / secret phrase**: the active key is
deterministically derived from it and can be regenerated in any wallet that
supports password login — most conveniently in bts.exchange.

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

Keys are stored encrypted in `profiles/keys.json` and held in RAM by the
credential daemon while the bot runs. See
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
- **Dry run** — **yes** for the first run (see next section).
- **startPrice** — leave the default (`"pool"` reads the liquidity-pool price,
  `"book"` reads the order-book mid price, or a number for a fixed anchor). If
  your pair has no native pool, set **poolRef** to a pool id such as `1.19.48`.

Keep all other defaults — they are sensible. The only things worth tuning later:
`targetSpreadPercent` (profit per cycle), `incrementPercent` (grid density),
`minPrice` / `maxPrice` (grid bounds), and `gridPrice` — set it to `"ama"` so
the market adapter centers the grid on the AMA signal. See the "Recommended Bot
Setup" section of the [README](../README.md).

### Activate the market adapter

For AMA pricing, enable the market adapter once:

```bash
dexbot white
```

This writes `profiles/market_adapter_whitelist.json` for your AMA bot so it
writes live grid files and recalc triggers. DEXBot2 starts/stops the adapter
automatically when active AMA bots exist.

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
| Logs | `profiles/logs/` — `dexbot.log`, `dexbot-error.log`, per-bot `<bot-name>.log` |
| Clear logs | `dexbot clear` |

See [LOGGING.md](LOGGING.md) for the full logging reference.

---

## 7. Go live

When the dry run looks correct:

1. Edit the bot with `dexbot bot` and set **Dry run** to **no**.
2. Make sure the account holds both pair assets (plus some BTS for fees).
3. Start:

   ```bash
   dexbot start
   ```

4. Watch the first cycles and verify orders appear on-chain (in your wallet's
   order book for the pair, or with `dexbot stat`).

Stop the runtime with `dexbot stop`. `dexbot restart` restarts it.

---

## Troubleshooting first-run mistakes

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
read the logs in `profiles/logs/`.

### "Where are the logs?"

Everything is under `profiles/logs/` — `dexbot.log` / `dexbot-error.log` for
the runtime, `<bot-name>.log` / `<bot-name>-error.log` per bot.

### "I forgot the master password"

The master password is never stored — it only exists in your head. It encrypts
all the private keys in `profiles/keys.json`, and there is **no recovery path**:
changing it requires the current password, so a forgotten one means the stored
keys can no longer be decrypted. Re-import your keys:

1. Delete `profiles/keys.json` (and any running bot/daemon that holds it open).
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

## Further reading

- [Root README](../README.md) — install, config, command reference
- [Credential Security](CREDENTIAL_SECURITY.md) — how keys are stored and signed
- [Market Adapter](../market_adapter/README.md) — AMA pricing and grid tuning
- [MPA and Credit Usage](MPA_CREDIT_USAGE.md) — borrowing and credit offer workflows
- [Logging](LOGGING.md) — log levels, rotation, and categories
- [DEXBot vs DEXBot2 Comparison](DEXBOT_COMPARISON.md) — how DEXBot2 differs from the original Python DEXBot

---

## Interaction

Different ways to interact with your BitShares account:

- [bts.exchange](https://bts.exchange) — Hosted reference wallet
- [Mobile App](https://github.com/bitshares/bitshares-mobile-app/releases) — Mobile Android app
- [Astro UI](https://github.com/BTS-CM/astro-ui/releases) — Local UI
- [BeetVault](https://github.com/beetapp/BeetVault) — Local Key Manager
- [BitShares Wallet](https://pi314x.github.io/bitshares-wallet-browser-extension) — Browser Extension
- [Paper Wallet](https://paperwallet.bitshares.eu/) — Print Wallet
- [DEXBot2](https://github.com/froooze/DEXBot2) — Automated grid trader

## Full Link Collection

- [BitShares IS AWESOME](https://github.com/bitshares/awesome-bitshares)

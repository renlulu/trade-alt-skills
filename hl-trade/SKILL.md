---
name: hl-trade
description: Trade Hyperliquid perpetuals from the command line — place market/limit orders, set leverage, close positions, cancel orders, and read account state, positions, open orders, and fills. Use when the user asks to open/close a position, buy/sell/long/short a perp, set leverage, cancel orders, or check their Hyperliquid account. Signs with an exported agent (API) wallet key that can trade but cannot withdraw funds.
---

# Hyperliquid Trading (hl-trade)

Place and manage Hyperliquid perpetual trades using an **agent (API) wallet
key** that the user exports from the trade.alt web app. The agent key can place
and cancel orders and change leverage, but **cannot withdraw or transfer funds** —
that restriction is enforced by Hyperliquid itself, so this is safe to hand to an
agent. The user's master wallet key never leaves their browser.

## Setup (one time)

1. **Install dependencies** in this skill folder:
   ```sh
   cd <this skill folder> && npm install
   ```
2. **Export the agent key from the app.** Open the trade.alt web app → **Agent**
   tab → *Export agent key*. Connect the wallet and enable trading if prompted,
   then copy the two values it shows.
3. **Set the environment** (paste the block the app gives you):
   ```sh
   export HL_ACCOUNT_ADDRESS="0xYourMasterAccount"
   export HL_AGENT_KEY="0xYourAgentPrivateKey"   # can trade, cannot withdraw
   # export HL_NETWORK="testnet"                 # optional; defaults to mainnet
   ```

## Usage

```sh
node scripts/hl.mjs <command> [flags]
```

### Read-only (need `HL_ACCOUNT_ADDRESS`)

```sh
node scripts/hl.mjs account        # equity, margin, withdrawable, open positions
node scripts/hl.mjs orders         # open orders with their oids
node scripts/hl.mjs fills --limit 30
node scripts/hl.mjs markets BTC    # search perps (mark price, max leverage, szDecimals)
```

### Trading (need `HL_AGENT_KEY`)

Every write command is a **dry run by default** — it prints exactly what it will
do. Add `--yes` to actually submit.

```sh
# Market buy $100 of BTC (size derived from mark price)
node scripts/hl.mjs order --coin BTC --side buy --usd 100 --yes

# Limit sell 0.5 ETH at 4000, with a stop loss
node scripts/hl.mjs order --coin ETH --side sell --size 0.5 --limit 4000 --sl 4200 --yes

# Open long with attached take-profit + stop-loss bracket
node scripts/hl.mjs order --coin SOL --side long --usd 250 --tp 200 --sl 150 --yes

# Set leverage, then close, then cancel
node scripts/hl.mjs leverage --coin BTC --x 10 --mode cross --yes
node scripts/hl.mjs close --coin BTC --yes
node scripts/hl.mjs cancel --coin ETH --oid 123456789 --yes
node scripts/hl.mjs cancel --coin ETH --all --yes
```

### `order` flags

| Flag | Meaning |
|------|---------|
| `--coin` | Perp symbol, e.g. `BTC`, `ETH`, `SOL` (required) |
| `--side` | `buy`/`long` or `sell`/`short` (required) |
| `--size` | Size in coin units. Mutually exclusive with `--usd` |
| `--usd` | Notional in USD; size = usd / mark price |
| `--limit` | Limit price. Omit for a market (IOC) order |
| `--reduce-only` | Only reduce an existing position |
| `--tp` / `--sl` | Attach take-profit / stop-loss trigger legs (open orders only) |
| `--slippage` | Market-order slippage bound, default `0.05` (5%) |
| `--yes` | Actually submit (otherwise dry-run) |

## Guidance for the agent

- **Always run the dry-run first** (omit `--yes`), show the user the preview, and
  only re-run with `--yes` after they confirm — these are real-money orders.
- Use `hl markets <coin>` to confirm the symbol and see `szDecimals`/`maxLeverage`
  before sizing an order.
- Sizes are rounded to the market's `szDecimals`; perp prices are rounded to 5
  significant figures and ≤ `6 - szDecimals` decimals (Hyperliquid's rules).
- After submitting, run `hl account` / `hl orders` to confirm the result.

## Scope

v1 covers **core Hyperliquid perpetuals**. Spot and HIP-3 (builder-deployed dex,
e.g. the `xyz` markets) are not yet supported here — their asset-id mapping
differs. For read-only leaderboard data, see the companion `hl-leaderboard` skill.

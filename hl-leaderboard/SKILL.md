---
name: hl-leaderboard
description: Query and track the Hyperliquid trader leaderboard (top traders by PnL or ROI over day/week/month/allTime) through the trade.alt cached API. Use when asked who the top Hyperliquid traders are, to rank traders by profit or return, to look up a specific wallet's leaderboard standing, or to compare windows.
---

# Hyperliquid Trader Leaderboard

This skill fetches the Hyperliquid trader leaderboard via the trade.alt backend
proxy (`/api/hl-leaderboard`). The proxy fetches the ~32MB upstream dump from
Hyperliquid, caches it for 5 minutes, and returns only a sorted top-N slice, so
you get a small, fast JSON payload instead of the full firehose.

## Setup

The script needs to know where the trade.alt API lives. Set `HL_API_BASE` to the
deployed origin (the host serving `server.mjs`). It defaults to
`http://localhost:8080` for local dev.

```sh
export HL_API_BASE="https://<your-trade-alt-host>"   # production
# or leave unset while running the local dev server (node server.mjs → :8080)
```

## Usage

Run the bundled script with Node (18+, for built-in `fetch`):

```sh
# Top 50 traders by PnL over the last day (defaults)
node scripts/leaderboard.mjs

# Top 10 by ROI over all time
node scripts/leaderboard.mjs --metric roi --window allTime --limit 10

# Look up where a specific wallet ranks (case-insensitive substring/address match)
node scripts/leaderboard.mjs --window week --address 0xabc123...

# Machine-readable output for further processing
node scripts/leaderboard.mjs --limit 20 --json
```

### Options

| Flag | Values | Default | Meaning |
|------|--------|---------|---------|
| `--window` | `day` `week` `month` `allTime` | `day` | Performance window to rank by |
| `--metric` | `pnl` `roi` | `pnl` | Sort key |
| `--limit` | `1`–`100` | `50` | Number of rows to return |
| `--address` | wallet address or display name | — | Filter to matching trader(s); shows their rank within the requested window |
| `--json` | — | off | Emit raw JSON instead of a formatted table |

## API reference

`GET {HL_API_BASE}/api/hl-leaderboard?window=day&metric=pnl&limit=50`

Response:

```json
{
  "window": "day",
  "metric": "pnl",
  "updatedAt": 1719100000000,
  "traders": [
    {
      "address": "0x...",
      "displayName": null,
      "accountValue": 1234567.8,
      "pnl": 98765.4,
      "roi": 0.123,
      "vlm": 4567890.1
    }
  ]
}
```

- `pnl` — profit/loss in USD over the window
- `roi` — return on investment as a fraction (0.123 = +12.3%)
- `vlm` — traded volume in USD over the window
- `accountValue` — current account equity in USD
- `updatedAt` — epoch ms when the server last refreshed its cache

## Tracking notes

This is an **on-demand** read: each invocation returns the current snapshot. To
track change over time, run it again later and compare addresses/PnL between
snapshots — the API itself keeps no history. The server cache is ~5 min, so
polling faster than that returns identical data.

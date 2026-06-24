# trade.alt agent skills

Hyperliquid agent skills for [Claude Code](https://claude.com/claude-code) and
Codex, companion to the [trade.alt](https://app.trade.xyz) app.

- **`hl-leaderboard`** — read-only: query the top Hyperliquid traders by PnL or
  ROI over day / week / month / all-time.
- **`hl-trade`** — trade Hyperliquid perpetuals: place market/limit orders, set
  leverage, close positions, cancel orders, and read account state. Signs with a
  Hyperliquid **agent (API) wallet** key that can trade but **cannot withdraw**.

## Install

```sh
git clone https://github.com/renlulu/trade-alt-skills.git
cp -R trade-alt-skills/hl-leaderboard trade-alt-skills/hl-trade ~/.claude/skills/
cd ~/.claude/skills/hl-trade && npm install   # the trade skill needs deps
```

For Codex, copy into `~/.codex/skills/` instead (or reference each `SKILL.md`
from your `AGENTS.md`).

## Getting the agent key (for `hl-trade`)

Open the trade.alt app → **Agent** tab → *Export agent key*. Connect your wallet,
enable trading if prompted, and copy the `HL_ACCOUNT_ADDRESS` / `HL_AGENT_KEY`
block into your shell. The agent key can place and cancel orders but cannot
withdraw funds — the master wallet key never leaves your browser.

See each skill's `SKILL.md` for full usage.

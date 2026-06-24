#!/usr/bin/env node
// Query the Hyperliquid trader leaderboard via the trade.alt API proxy.
// See ../SKILL.md for full usage. Node 18+ (built-in fetch).

const API_BASE = (process.env.HL_API_BASE || "http://localhost:8080").replace(/\/+$/, "");
const WINDOWS = new Set(["day", "week", "month", "allTime"]);

function parseArgs(argv) {
  const opts = { window: "day", metric: "pnl", limit: 50, address: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--window") opts.window = next();
    else if (arg === "--metric") opts.metric = next();
    else if (arg === "--limit") opts.limit = Number(next());
    else if (arg === "--address") opts.address = next();
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      opts.help = true;
    }
  }
  return opts;
}

function usage() {
  console.log(`Usage: node leaderboard.mjs [options]

  --window <day|week|month|allTime>  performance window (default: day)
  --metric <pnl|roi>                 sort key (default: pnl)
  --limit <1-100>                    rows to return (default: 50)
  --address <addr|name>              filter to matching trader(s)
  --json                             raw JSON output
  -h, --help                         this help

Set HL_API_BASE to the deployed trade.alt origin (default: http://localhost:8080).`);
}

function fmtUsd(n) {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function fmtPct(roi) {
  if (!Number.isFinite(roi)) return "—";
  return `${roi >= 0 ? "+" : ""}${(roi * 100).toFixed(2)}%`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return usage();

  if (!WINDOWS.has(opts.window)) {
    console.error(`Invalid --window "${opts.window}". Use one of: ${[...WINDOWS].join(", ")}`);
    process.exit(1);
  }
  if (opts.metric !== "pnl" && opts.metric !== "roi") {
    console.error(`Invalid --metric "${opts.metric}". Use pnl or roi.`);
    process.exit(1);
  }
  const limit = Math.min(100, Math.max(1, opts.limit || 50));

  // Ask for the full 100 when filtering by address so the rank is meaningful.
  const fetchLimit = opts.address ? 100 : limit;
  const url = `${API_BASE}/api/hl-leaderboard?window=${opts.window}&metric=${opts.metric}&limit=${fetchLimit}`;

  let payload;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(35_000) });
    if (!res.ok) {
      console.error(`API ${res.status} from ${url}`);
      process.exit(1);
    }
    payload = await res.json();
  } catch (err) {
    console.error(`Failed to reach ${url}: ${err.message}`);
    console.error(`Is HL_API_BASE correct? Currently: ${API_BASE}`);
    process.exit(1);
  }

  let rows = (payload.traders || []).map((t, i) => ({ rank: i + 1, ...t }));

  if (opts.address) {
    const q = opts.address.toLowerCase();
    rows = rows.filter(
      (t) => (t.address || "").toLowerCase().includes(q) || (t.displayName || "").toLowerCase().includes(q),
    );
  } else {
    rows = rows.slice(0, limit);
  }

  if (opts.json) {
    console.log(JSON.stringify({ ...payload, traders: rows }, null, 2));
    return;
  }

  const updated = payload.updatedAt ? new Date(payload.updatedAt).toISOString() : "unknown";
  console.log(`Hyperliquid leaderboard — window=${opts.window} sorted by ${opts.metric} (updated ${updated})`);
  if (!rows.length) {
    console.log(opts.address ? `No trader matching "${opts.address}" in top 100.` : "No rows returned.");
    return;
  }
  console.log("");
  console.log(`  #   ${"trader".padEnd(44)} ${"PnL".padStart(11)} ${"ROI".padStart(9)} ${"volume".padStart(10)} ${"equity".padStart(10)}`);
  console.log(`  ${"".padEnd(44 + 4 + 11 + 9 + 10 + 10 + 5, "-")}`);
  for (const t of rows) {
    const name = t.displayName ? `${t.displayName} (${t.address.slice(0, 8)}…)` : t.address;
    console.log(
      `  ${String(t.rank).padStart(3)} ${name.padEnd(44)} ${fmtUsd(t.pnl).padStart(11)} ${fmtPct(t.roi).padStart(9)} ${fmtUsd(t.vlm).padStart(10)} ${fmtUsd(t.accountValue).padStart(10)}`,
    );
  }
}

main();

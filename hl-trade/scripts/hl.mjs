#!/usr/bin/env node
// Hyperliquid perps trading CLI for the hl-trade skill. Signs with an agent
// (API) wallet key exported from the trade.alt web app — it can place/cancel
// orders and set leverage, but CANNOT withdraw funds. See ../SKILL.md.
//
// Config (env):
//   HL_AGENT_KEY        agent wallet private key (0x + 64 hex) — required for writes
//   HL_ACCOUNT_ADDRESS  master account address (0x...)        — required for queries
//   HL_NETWORK          "mainnet" (default) or "testnet"
//
// Commands:
//   account | positions | orders | fills [--limit N] | markets [query]
//   order  --coin BTC --side buy|sell (--size N | --usd N) [--limit PX]
//          [--reduce-only] [--tp PX] [--sl PX] [--slippage 0.05] [--yes]
//   close  --coin BTC [--slippage 0.05] [--yes]
//   cancel --coin BTC (--oid N | --all) [--yes]
//   leverage --coin BTC --x 10 [--mode cross|isolated]

import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";

// ---------- arg parsing ----------
const argv = process.argv.slice(2);
const command = argv[0];
const flags = {};
const positionals = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[key] = true;
    else { flags[key] = next; i++; }
  } else positionals.push(a);
}

const fail = (msg) => { console.error(`error: ${msg}`); process.exit(1); };

// ---------- config / clients ----------
const isTestnet = (process.env.HL_NETWORK || "mainnet").toLowerCase() === "testnet";
const transport = new HttpTransport({ isTestnet });
const info = new InfoClient({ transport });

function account() {
  const addr = process.env.HL_ACCOUNT_ADDRESS;
  if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) fail("set HL_ACCOUNT_ADDRESS to your master account address (0x...).");
  return addr.toLowerCase();
}
function exchange() {
  const key = process.env.HL_AGENT_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) fail("set HL_AGENT_KEY to your exported agent key (0x + 64 hex). Export it from the Agent tab in the app.");
  return new ExchangeClient({ transport, wallet: privateKeyToAccount(key) });
}

// ---------- number formatting (HL rules) ----------
function fmtNum(n) {
  if (!Number.isFinite(n)) fail(`bad number: ${n}`);
  let s = n.toFixed(12);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}
function roundSize(sz, szDecimals) {
  const n = Number(sz);
  if (!Number.isFinite(n) || n <= 0) fail(`bad size: ${sz}`);
  return fmtNum(Number(n.toFixed(szDecimals)));
}
// Perp prices: max 5 significant figures and at most (6 - szDecimals) decimals.
function formatPrice(px, szDecimals) {
  const n = Number(px);
  if (!Number.isFinite(n) || n <= 0) fail(`bad price: ${px}`);
  const maxDec = Math.max(0, 6 - szDecimals);
  const sig = Number(n.toPrecision(5));
  return fmtNum(Number(sig.toFixed(maxDec)));
}
function slippagePrice(px, isBuy, slip) {
  return Number(px) * (isBuy ? 1 + slip : 1 - slip);
}
function makeCloid() {
  return `0x${randomBytes(16).toString("hex")}`;
}

// ---------- market metadata ----------
let _markets = null;
async function markets() {
  if (_markets) return _markets;
  const [meta, ctxs] = await info.metaAndAssetCtxs();
  const map = new Map();
  meta.universe.forEach((u, i) => {
    map.set(u.name.toUpperCase(), {
      name: u.name,
      assetId: i,
      szDecimals: u.szDecimals,
      maxLeverage: u.maxLeverage,
      markPx: Number(ctxs[i]?.markPx),
      oraclePx: Number(ctxs[i]?.oraclePx),
    });
  });
  _markets = map;
  return map;
}
async function resolve(coin) {
  if (!coin || coin === true) fail("--coin is required (e.g. --coin BTC).");
  const m = (await markets()).get(String(coin).toUpperCase());
  if (!m) fail(`unknown perp coin: ${coin}. Run "hl markets ${coin}" to search.`);
  if (!Number.isFinite(m.markPx) || m.markPx <= 0) fail(`no live mark price for ${coin}.`);
  return m;
}

// ---------- order status reporting ----------
function reportStatuses(res) {
  const statuses = res?.response?.data?.statuses ?? [];
  let ok = true;
  statuses.forEach((s, i) => {
    if (s && typeof s === "object" && "error" in s) { ok = false; console.log(`  order ${i}: REJECTED — ${s.error}`); }
    else if (s && typeof s === "object" && "resting" in s) console.log(`  order ${i}: resting oid=${s.resting.oid}`);
    else if (s && typeof s === "object" && "filled" in s) console.log(`  order ${i}: filled ${s.filled.totalSz} @ ${s.filled.avgPx} (oid=${s.filled.oid})`);
    else console.log(`  order ${i}: ${JSON.stringify(s)}`);
  });
  if (!ok) process.exitCode = 1;
}

// ---------- commands ----------
async function cmdAccount() {
  const user = account();
  const st = await info.clearinghouseState({ user });
  const s = st.marginSummary;
  console.log(`Account ${user}${isTestnet ? " (testnet)" : ""}`);
  console.log(`  Equity:        $${Number(s.accountValue).toLocaleString()}`);
  console.log(`  Margin used:   $${Number(s.totalMarginUsed).toLocaleString()}`);
  console.log(`  Withdrawable:  $${Number(st.withdrawable).toLocaleString()}`);
  const positions = st.assetPositions.filter((p) => Number(p.position.szi) !== 0);
  if (!positions.length) { console.log("  No open positions."); return; }
  console.log(`\n  ${"coin".padEnd(10)} ${"size".padStart(14)} ${"entry".padStart(12)} ${"uPnL".padStart(12)} ${"lev".padStart(6)}`);
  for (const p of positions) {
    const pos = p.position;
    console.log(`  ${pos.coin.padEnd(10)} ${pos.szi.padStart(14)} ${pos.entryPx.padStart(12)} ${("$" + Number(pos.unrealizedPnl).toFixed(2)).padStart(12)} ${(pos.leverage.value + "x").padStart(6)}`);
  }
}

async function cmdOrders() {
  const user = account();
  const orders = await info.frontendOpenOrders({ user });
  if (!orders.length) { console.log("No open orders."); return; }
  console.log(`${"oid".padEnd(12)} ${"coin".padEnd(8)} ${"side".padEnd(5)} ${"size".padStart(12)} ${"limitPx".padStart(12)} type`);
  for (const o of orders) {
    const side = o.side === "B" ? "buy" : "sell";
    const type = o.orderType + (o.reduceOnly ? " RO" : "");
    console.log(`${String(o.oid).padEnd(12)} ${o.coin.padEnd(8)} ${side.padEnd(5)} ${o.sz.padStart(12)} ${o.limitPx.padStart(12)} ${type}`);
  }
}

async function cmdFills() {
  const user = account();
  const limit = Number(flags.limit) || 20;
  const fills = (await info.userFills({ user })).slice(0, limit);
  if (!fills.length) { console.log("No fills."); return; }
  console.log(`${"time".padEnd(20)} ${"coin".padEnd(8)} ${"dir".padEnd(10)} ${"px".padStart(12)} ${"size".padStart(12)} ${"closedPnl".padStart(12)}`);
  for (const f of fills) {
    const t = new Date(f.time).toISOString().slice(0, 19).replace("T", " ");
    console.log(`${t.padEnd(20)} ${f.coin.padEnd(8)} ${String(f.dir).padEnd(10)} ${f.px.padStart(12)} ${f.sz.padStart(12)} ${("$" + Number(f.closedPnl).toFixed(2)).padStart(12)}`);
  }
}

async function cmdMarkets() {
  const q = (positionals[0] || flags.query || "").toString().toUpperCase();
  const all = [...(await markets()).values()];
  const rows = (q ? all.filter((m) => m.name.toUpperCase().includes(q)) : all).sort((a, b) => a.name.localeCompare(b.name));
  console.log(`${"coin".padEnd(12)} ${"mark".padStart(14)} ${"maxLev".padStart(7)} ${"szDec".padStart(6)}`);
  for (const m of rows.slice(0, q ? 50 : 60)) {
    console.log(`${m.name.padEnd(12)} ${fmtNum(m.markPx).padStart(14)} ${(m.maxLeverage + "x").padStart(7)} ${String(m.szDecimals).padStart(6)}`);
  }
  if (!q && all.length > 60) console.log(`… ${all.length - 60} more. Filter with: hl markets <query>`);
}

async function cmdOrder() {
  const m = await resolve(flags.coin);
  const sideRaw = String(flags.side || "").toLowerCase();
  const isBuy = sideRaw === "buy" || sideRaw === "long" || sideRaw === "b";
  const isSell = sideRaw === "sell" || sideRaw === "short" || sideRaw === "s";
  if (!isBuy && !isSell) fail("--side must be buy|sell (or long|short).");
  const reduceOnly = Boolean(flags["reduce-only"] || flags.reduceonly || flags.r);
  const slip = flags.slippage != null ? Number(flags.slippage) : 0.05;
  if (!Number.isFinite(slip) || slip < 0 || slip > 0.5) fail("--slippage must be between 0 and 0.5.");

  let size;
  if (flags.size != null && flags.size !== true) size = Number(flags.size);
  else if (flags.usd != null && flags.usd !== true) size = Number(flags.usd) / m.markPx;
  else fail("provide --size <coin units> or --usd <notional>.");
  const sizeStr = roundSize(size, m.szDecimals);

  const isMarket = flags.limit == null || flags.limit === true;
  const tif = isMarket ? "Ioc" : "Gtc";
  const refPx = isMarket ? m.markPx : Number(flags.limit);
  if (!isMarket && (!Number.isFinite(refPx) || refPx <= 0)) fail("--limit must be a positive price.");
  const px = isMarket ? slippagePrice(m.markPx, isBuy, slip) : refPx;

  const orders = [{
    a: m.assetId, b: isBuy, p: formatPrice(px, m.szDecimals), s: sizeStr, r: reduceOnly,
    t: { limit: { tif } }, c: makeCloid(),
  }];

  // Optional TP/SL bracket (only when opening, not reduce-only).
  const tp = flags.tp != null && flags.tp !== true ? Number(flags.tp) : null;
  const sl = flags.sl != null && flags.sl !== true ? Number(flags.sl) : null;
  if ((tp != null || sl != null) && !reduceOnly) {
    if (tp != null) { if (isBuy ? tp <= refPx : tp >= refPx) fail(`take profit must be ${isBuy ? "above" : "below"} ${refPx}.`); }
    if (sl != null) { if (isBuy ? sl >= refPx : sl <= refPx) fail(`stop loss must be ${isBuy ? "below" : "above"} ${refPx}.`); }
    const closeIsBuy = !isBuy;
    const leg = (trigPx, kind) => ({
      a: m.assetId, b: closeIsBuy, p: formatPrice(slippagePrice(trigPx, closeIsBuy, slip), m.szDecimals), s: sizeStr, r: true,
      t: { trigger: { isMarket: true, triggerPx: formatPrice(trigPx, m.szDecimals), tpsl: kind } }, c: makeCloid(),
    });
    if (tp != null) orders.push(leg(tp, "tp"));
    if (sl != null) orders.push(leg(sl, "sl"));
  }
  const grouping = orders.length > 1 ? "normalTpsl" : "na";

  console.log(`${isMarket ? "MARKET" : "LIMIT"} ${isBuy ? "BUY" : "SELL"} ${sizeStr} ${m.name} @ ${orders[0].p}${reduceOnly ? " [reduce-only]" : ""}`);
  console.log(`  mark=${fmtNum(m.markPx)} notional≈$${(Number(sizeStr) * m.markPx).toFixed(2)}${isMarket ? ` slippage=${slip * 100}%` : ""}`);
  if (orders.length > 1) console.log(`  +${orders.length - 1} TP/SL leg(s)`);
  if (!flags.yes) { console.log("\ndry-run. Re-run with --yes to submit."); return; }

  const res = await exchange().order({ orders, grouping });
  console.log("submitted:");
  reportStatuses(res);
}

async function cmdClose() {
  const m = await resolve(flags.coin);
  const user = account();
  const slip = flags.slippage != null ? Number(flags.slippage) : 0.05;
  const st = await info.clearinghouseState({ user });
  const pos = st.assetPositions.map((p) => p.position).find((p) => p.coin.toUpperCase() === m.name.toUpperCase() && Number(p.szi) !== 0);
  if (!pos) { console.log(`No open ${m.name} position.`); return; }
  const szi = Number(pos.szi);
  const closeIsBuy = szi < 0; // short → buy to close
  const sizeStr = roundSize(Math.abs(szi), m.szDecimals);
  const px = slippagePrice(m.markPx, closeIsBuy, slip);
  const order = { a: m.assetId, b: closeIsBuy, p: formatPrice(px, m.szDecimals), s: sizeStr, r: true, t: { limit: { tif: "Ioc" } }, c: makeCloid() };

  console.log(`CLOSE ${szi > 0 ? "LONG" : "SHORT"} ${sizeStr} ${m.name} (market ${closeIsBuy ? "buy" : "sell"} @ ${order.p})`);
  console.log(`  entry=${fmtNum(Number(pos.entryPx))} uPnL=$${Number(pos.unrealizedPnl).toFixed(2)}`);
  if (!flags.yes) { console.log("\ndry-run. Re-run with --yes to submit."); return; }
  const res = await exchange().order({ orders: [order], grouping: "na" });
  console.log("submitted:");
  reportStatuses(res);
}

async function cmdCancel() {
  const m = await resolve(flags.coin);
  const exch = exchange();
  if (flags.all) {
    const user = account();
    const open = (await info.frontendOpenOrders({ user })).filter((o) => o.coin.toUpperCase() === m.name.toUpperCase());
    if (!open.length) { console.log(`No open ${m.name} orders.`); return; }
    console.log(`Cancelling ${open.length} ${m.name} order(s): ${open.map((o) => o.oid).join(", ")}`);
    if (!flags.yes) { console.log("\ndry-run. Re-run with --yes to submit."); return; }
    const res = await exch.cancel({ cancels: open.map((o) => ({ a: m.assetId, o: o.oid })) });
    console.log("done:", JSON.stringify(res.response?.data?.statuses ?? res));
    return;
  }
  const oid = Number(flags.oid);
  if (!Number.isSafeInteger(oid) || oid <= 0) fail("provide --oid <id> or --all.");
  console.log(`Cancel ${m.name} order oid=${oid}`);
  if (!flags.yes) { console.log("\ndry-run. Re-run with --yes to submit."); return; }
  const res = await exch.cancel({ cancels: [{ a: m.assetId, o: oid }] });
  console.log("done:", JSON.stringify(res.response?.data?.statuses ?? res));
}

async function cmdLeverage() {
  const m = await resolve(flags.coin);
  const x = Number(flags.x ?? flags.leverage);
  if (!Number.isInteger(x) || x < 1 || x > m.maxLeverage) fail(`--x must be an integer 1..${m.maxLeverage} for ${m.name}.`);
  const isCross = String(flags.mode || "cross").toLowerCase() !== "isolated";
  console.log(`Set ${m.name} leverage ${x}x ${isCross ? "cross" : "isolated"}`);
  if (!flags.yes) { console.log("\ndry-run. Re-run with --yes to submit."); return; }
  const res = await exchange().updateLeverage({ asset: m.assetId, isCross, leverage: x });
  console.log("done:", JSON.stringify(res));
}

function usage() {
  console.log(`hl — Hyperliquid perps trading (agent key signing)

Queries (need HL_ACCOUNT_ADDRESS):
  hl account                      equity, margin, open positions
  hl orders                       open orders
  hl fills [--limit N]            recent fills (default 20)
  hl markets [query]              list/search perps

Trading (need HL_AGENT_KEY; add --yes to actually submit):
  hl order --coin BTC --side buy --usd 100 [--limit PX] [--reduce-only]
           [--tp PX] [--sl PX] [--slippage 0.05] --yes
  hl close --coin BTC [--slippage 0.05] --yes
  hl cancel --coin BTC (--oid N | --all) --yes
  hl leverage --coin BTC --x 10 [--mode cross|isolated] --yes

The agent key can trade but cannot withdraw. Export it from the app's Agent tab.`);
}

const commands = {
  account: cmdAccount, positions: cmdAccount,
  orders: cmdOrders, fills: cmdFills, markets: cmdMarkets,
  order: cmdOrder, close: cmdClose, cancel: cmdCancel, leverage: cmdLeverage,
  help: async () => usage(),
};

const run = commands[command];
if (!run) { usage(); process.exit(command ? 1 : 0); }
run().catch((e) => fail(e?.message || String(e)));

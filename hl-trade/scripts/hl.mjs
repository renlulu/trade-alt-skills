#!/usr/bin/env node
// Hyperliquid perps trading CLI for the hl-trade skill. Signs with an agent
// (API) wallet key exported from the trade.alt web app — it can place/cancel
// orders and set leverage, but CANNOT withdraw funds. See ../SKILL.md.
//
// Covers core Hyperliquid perps AND the "xyz" HIP-3 dex (tokenised stocks like
// xyz:SPCX). Accounts use unified collateral: USDC backs perp positions.
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

import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid";
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
const HL_INFO_URL = isTestnet ? "https://api.hyperliquid-testnet.xyz/info" : "https://api.hyperliquid.xyz/info";

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

async function hlInfo(body) {
  const r = await fetch(HL_INFO_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`HL info ${r.status}`);
  return r.json();
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
function usd(n) {
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
}

// ---------- markets (core + HIP-3 dexes) ----------
// trade.xyz spans the core perps plus the "xyz" builder dex. Each dex has an
// asset-id offset (100000 + dexIndex*10000 + indexInUniverse); the offset routes
// an order to the right dex when it's placed.
const PERP_DEXS = ["", "xyz", "flx", "hyna", "km", "abcd", "cash", "para"];
let _dexIdx = null;
async function dexIndexes() {
  if (_dexIdx) return _dexIdx;
  const dexs = await hlInfo({ type: "perpDexs" });
  _dexIdx = new Map();
  dexs.forEach((d, i) => { if (i > 0 && d?.name) _dexIdx.set(d.name, i); });
  return _dexIdx;
}
async function dexOffset(dex) {
  if (!dex) return 0;
  const i = (await dexIndexes()).get(dex);
  if (!i) throw new Error(`perp dex ${dex} not found`);
  return 100_000 + i * 10_000;
}
let _perps = null;
async function allPerps() {
  if (_perps) return _perps;
  const list = [];
  for (const dex of PERP_DEXS) {
    try {
      const [meta, ctxs] = await hlInfo(dex ? { type: "metaAndAssetCtxs", dex } : { type: "metaAndAssetCtxs" });
      const offset = await dexOffset(dex);
      meta.universe.forEach((u, i) => {
        const bare = u.name.replace(/^[a-z0-9]+:/i, "");
        list.push({ dex, coin: dex ? `${dex}:${bare}` : u.name, bare, assetId: offset + i, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage, markPx: Number(ctxs[i]?.markPx) });
      });
    } catch (e) {
      if (!dex) throw e; // core is required; satellite dexes are best-effort
    }
  }
  _perps = list;
  return list;
}
async function resolve(coin) {
  if (!coin || coin === true) fail("--coin is required (e.g. --coin BTC or --coin xyz:SPCX).");
  const q = String(coin).toUpperCase().replace(/\s+/g, "");
  const list = await allPerps();
  const m = list.find((x) => x.coin.toUpperCase() === q) || list.find((x) => x.bare.toUpperCase() === q);
  if (!m) fail(`unknown perp: ${coin}. Run "hl markets ${coin}" to search.`);
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
  const states = await Promise.all(PERP_DEXS.map((dex) =>
    hlInfo(dex ? { type: "clearinghouseState", user, dex } : { type: "clearinghouseState", user }).then((st) => ({ dex, st })).catch(() => ({ dex, st: null })),
  ));
  const spot = await hlInfo({ type: "spotClearinghouseState", user }).catch(() => ({ balances: [] }));
  const tag = (coin, dex) => (dex && !String(coin).includes(":") ? `${dex}:${coin}` : coin);
  const positions = states.flatMap(({ st, dex }) => (st?.assetPositions || []).map((p) => p.position).filter((p) => Number(p.szi) !== 0)
    .map((p) => ({ coin: tag(p.coin, dex), szi: p.szi, entryPx: p.entryPx, uPnL: Number(p.unrealizedPnl), lev: p.leverage?.value })));
  const perpAccountValue = states.reduce((s, { st }) => s + (Number(st?.marginSummary?.accountValue) || 0), 0);
  const reserved = states.reduce((s, { st }) => s + (Number(st?.marginSummary?.totalMarginUsed) || 0), 0);
  const upnl = positions.reduce((s, p) => s + (Number.isFinite(p.uPnL) ? p.uPnL : 0), 0);
  const balances = (spot.balances || []).filter((b) => Number(b.total) > 0);
  const usdc = balances.find((b) => b.coin === "USDC");
  const usdcTotal = Number(usdc?.total) || 0;
  const usdcHold = Number(usdc?.hold) || 0;
  // Unified collateral: perp margin is held inside the USDC balance, so net it
  // out instead of double-adding perp + spot (correct for non-unified too).
  const collateral = usdcTotal + perpAccountValue - usdcHold;

  console.log(`Account ${user}${isTestnet ? " (testnet)" : ""} — unified collateral`);
  console.log(`  Collateral (USDC): ${usd(collateral)}  (reserved ${usd(reserved)}, available ${usd(collateral - reserved)})`);
  console.log(`  Unrealized PnL:    ${usd(upnl)}`);
  console.log(`  Equity if closed:  ${usd(collateral + upnl)}`);
  const others = balances.filter((b) => b.coin !== "USDC");
  if (others.length) console.log(`  Spot tokens:       ${others.map((b) => `${fmtNum(Number(b.total))} ${b.coin}`).join(", ")}`);
  if (!positions.length) { console.log("  No open positions."); return; }
  console.log(`\n  ${"coin".padEnd(12)} ${"size".padStart(12)} ${"entry".padStart(12)} ${"uPnL".padStart(12)} ${"lev".padStart(5)}`);
  for (const p of positions) {
    console.log(`  ${p.coin.padEnd(12)} ${p.szi.padStart(12)} ${p.entryPx.padStart(12)} ${usd(p.uPnL).padStart(12)} ${((p.lev ?? "?") + "x").padStart(5)}`);
  }
}

async function cmdOrders() {
  const user = account();
  const orders = (await Promise.all(PERP_DEXS.map((dex) =>
    hlInfo(dex ? { type: "frontendOpenOrders", user, dex } : { type: "frontendOpenOrders", user }).catch(() => []),
  ))).flat();
  if (!orders.length) { console.log("No open orders."); return; }
  console.log(`${"oid".padEnd(12)} ${"coin".padEnd(12)} ${"side".padEnd(5)} ${"size".padStart(12)} ${"limitPx".padStart(12)} type`);
  for (const o of orders) {
    const side = o.side === "B" ? "buy" : "sell";
    const type = o.orderType + (o.reduceOnly ? " RO" : "");
    console.log(`${String(o.oid).padEnd(12)} ${o.coin.padEnd(12)} ${side.padEnd(5)} ${o.sz.padStart(12)} ${o.limitPx.padStart(12)} ${type}`);
  }
}

async function cmdFills() {
  const user = account();
  const limit = Number(flags.limit) || 20;
  const fills = (await hlInfo({ type: "userFills", user, aggregateByTime: true })).slice(0, limit);
  if (!fills.length) { console.log("No fills."); return; }
  console.log(`${"time".padEnd(20)} ${"coin".padEnd(12)} ${"dir".padEnd(10)} ${"px".padStart(12)} ${"size".padStart(12)} ${"closedPnl".padStart(12)}`);
  for (const f of fills) {
    const t = new Date(f.time).toISOString().slice(0, 19).replace("T", " ");
    console.log(`${t.padEnd(20)} ${f.coin.padEnd(12)} ${String(f.dir).padEnd(10)} ${f.px.padStart(12)} ${f.sz.padStart(12)} ${usd(Number(f.closedPnl)).padStart(12)}`);
  }
}

async function cmdMarkets() {
  const q = (positionals[0] || flags.query || "").toString().toUpperCase();
  const list = await allPerps();
  const rows = (q ? list.filter((m) => m.coin.toUpperCase().includes(q) || m.bare.toUpperCase().includes(q)) : list).sort((a, b) => a.coin.localeCompare(b.coin));
  console.log(`${"coin".padEnd(14)} ${"mark".padStart(14)} ${"maxLev".padStart(7)} ${"szDec".padStart(6)}`);
  for (const m of rows.slice(0, q ? 60 : 80)) {
    console.log(`${m.coin.padEnd(14)} ${fmtNum(m.markPx).padStart(14)} ${(m.maxLeverage + "x").padStart(7)} ${String(m.szDecimals).padStart(6)}`);
  }
  if (!q && list.length > 80) console.log(`… ${list.length - 80} more. Filter with: hl markets <query>`);
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

  console.log(`${isMarket ? "MARKET" : "LIMIT"} ${isBuy ? "BUY" : "SELL"} ${sizeStr} ${m.coin} @ ${orders[0].p}${reduceOnly ? " [reduce-only]" : ""}`);
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
  const st = await hlInfo(m.dex ? { type: "clearinghouseState", user, dex: m.dex } : { type: "clearinghouseState", user });
  const pos = (st.assetPositions || []).map((p) => p.position)
    .find((p) => p.coin.replace(/^[a-z0-9]+:/i, "").toUpperCase() === m.bare.toUpperCase() && Number(p.szi) !== 0);
  if (!pos) { console.log(`No open ${m.coin} position.`); return; }
  const szi = Number(pos.szi);
  const closeIsBuy = szi < 0; // short → buy to close
  const sizeStr = roundSize(Math.abs(szi), m.szDecimals);
  const px = slippagePrice(m.markPx, closeIsBuy, slip);
  const order = { a: m.assetId, b: closeIsBuy, p: formatPrice(px, m.szDecimals), s: sizeStr, r: true, t: { limit: { tif: "Ioc" } }, c: makeCloid() };

  console.log(`CLOSE ${szi > 0 ? "LONG" : "SHORT"} ${sizeStr} ${m.coin} (market ${closeIsBuy ? "buy" : "sell"} @ ${order.p})`);
  console.log(`  entry=${fmtNum(Number(pos.entryPx))} uPnL=${usd(Number(pos.unrealizedPnl))}`);
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
    const open = (await hlInfo(m.dex ? { type: "frontendOpenOrders", user, dex: m.dex } : { type: "frontendOpenOrders", user }))
      .filter((o) => o.coin.replace(/^[a-z0-9]+:/i, "").toUpperCase() === m.bare.toUpperCase());
    if (!open.length) { console.log(`No open ${m.coin} orders.`); return; }
    console.log(`Cancelling ${open.length} ${m.coin} order(s): ${open.map((o) => o.oid).join(", ")}`);
    if (!flags.yes) { console.log("\ndry-run. Re-run with --yes to submit."); return; }
    const res = await exch.cancel({ cancels: open.map((o) => ({ a: m.assetId, o: o.oid })) });
    console.log("done:", JSON.stringify(res.response?.data?.statuses ?? res));
    return;
  }
  const oid = Number(flags.oid);
  if (!Number.isSafeInteger(oid) || oid <= 0) fail("provide --oid <id> or --all.");
  console.log(`Cancel ${m.coin} order oid=${oid}`);
  if (!flags.yes) { console.log("\ndry-run. Re-run with --yes to submit."); return; }
  const res = await exch.cancel({ cancels: [{ a: m.assetId, o: oid }] });
  console.log("done:", JSON.stringify(res.response?.data?.statuses ?? res));
}

async function cmdLeverage() {
  const m = await resolve(flags.coin);
  const x = Number(flags.x ?? flags.leverage);
  if (!Number.isInteger(x) || x < 1 || x > m.maxLeverage) fail(`--x must be an integer 1..${m.maxLeverage} for ${m.coin}.`);
  const isCross = String(flags.mode || "cross").toLowerCase() !== "isolated";
  console.log(`Set ${m.coin} leverage ${x}x ${isCross ? "cross" : "isolated"}`);
  if (!flags.yes) { console.log("\ndry-run. Re-run with --yes to submit."); return; }
  const res = await exchange().updateLeverage({ asset: m.assetId, isCross, leverage: x });
  console.log("done:", JSON.stringify(res));
}

function usage() {
  console.log(`hl — Hyperliquid perps trading (agent key signing)

Covers core perps + the xyz HIP-3 dex (e.g. xyz:SPCX). Unified collateral.

Queries (need HL_ACCOUNT_ADDRESS):
  hl account                      collateral, margin, unrealized PnL, positions
  hl orders                       open orders (all dexes)
  hl fills [--limit N]            recent fills (default 20)
  hl markets [query]              list/search perps (core + xyz)

Trading (need HL_AGENT_KEY; add --yes to actually submit):
  hl order --coin BTC --side buy --usd 100 [--limit PX] [--reduce-only]
           [--tp PX] [--sl PX] [--slippage 0.05] --yes
  hl close --coin xyz:SPCX [--slippage 0.05] --yes
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

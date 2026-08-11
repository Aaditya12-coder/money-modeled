// fetch-nse.mjs
// Pulls live quotes + daily history for your watchlist through THREE
// independent pathways, tried in order, so one source failing doesn't mean
// a stock silently vanishes from your data:
//
//   1. NSE directly    — most complete data, but the most bot-sensitive
//   2. BSE directly     — a genuinely different exchange/source, used only
//                         for symbols where you've supplied a bseCode in
//                         watchlist.json (BSE identifies stocks by numeric
//                         "scrip code", not by NSE-style text symbols, so
//                         this can't be auto-resolved — see watchlist.json)
//   3. Yahoo Finance     — a reliable relay of the same NSE-listed prices,
//                         used as the last resort if both direct exchanges
//                         refuse the request
//
// Honesty note on confidence: NSE's endpoints (tier 1) are well-understood
// and widely used for this kind of thing. Yahoo's chart API (tier 3) is
// similarly well-trodden and stable. BSE's endpoints (tier 2) are the least
// verified of the three — reverse-engineered from BSE's own website with no
// official documentation, and not something I've been able to test against
// the live internet. If tier 2 turns out broken, tiers 1 and 3 still cover
// you completely; check the Action's logs for "bse" failures specifically
// if you want to debug that path further.
//
// Output: data/stocks.json
//   { "<SYMBOL>": { price, change, pctChange, dayHigh, dayLow, history: [{date, close}], source } }
//
// Run with: node fetch-nse.mjs

import { writeFileSync, mkdirSync, readFileSync } from "fs";

const NSE_BASE = "https://www.nseindia.com";
const NSE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.nseindia.com/",
};

function extractCookies(res) {
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return setCookie.map((c) => c.split(";")[0]).join("; ");
}

async function getNseSessionCookies() {
  const res = await fetch(NSE_BASE, { headers: NSE_HEADERS });
  return extractCookies(res);
}

async function nseFetch(path, cookies) {
  const res = await fetch(`${NSE_BASE}${path}`, { headers: { ...NSE_HEADERS, Cookie: cookies } });
  if (!res.ok) throw new Error(`NSE fetch failed for ${path}: ${res.status}`);
  return res.json();
}

function fmtDateNse(d) {
  return `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
}

async function fetchFromNse(symbol, cookies, from, to) {
  const quote = await nseFetch(`/api/quote-equity?symbol=${encodeURIComponent(symbol)}`, cookies);
  const priceInfo = quote.priceInfo || {};

  const hist = await nseFetch(
    `/api/historical/cm/equity?symbol=${encodeURIComponent(symbol)}&series=["EQ"]&from=${fmtDateNse(from)}&to=${fmtDateNse(to)}`,
    cookies
  );
  const history = (hist.data || [])
    .map((row) => ({ date: row.CH_TIMESTAMP, close: parseFloat(row.CH_CLOSING_PRICE) }))
    .filter((r) => !isNaN(r.close))
    .reverse();

  return {
    price: priceInfo.lastPrice ?? null,
    change: priceInfo.change ?? null,
    pctChange: priceInfo.pChange ?? null,
    dayHigh: priceInfo.intraDayHighLow?.max ?? null,
    dayLow: priceInfo.intraDayHighLow?.min ?? null,
    history,
    source: "nse",
  };
}

// BSE's own API, keyed by numeric scrip code rather than a text symbol.
// Best-effort / least-verified of the three tiers — see file header.
const BSE_HEADERS = {
  "User-Agent": NSE_HEADERS["User-Agent"],
  Accept: "application/json",
  Referer: "https://www.bseindia.com/",
};

async function fetchFromBse(bseCode) {
  const quoteRes = await fetch(
    `https://api.bseindia.com/BseIndiaAPI/api/getScripHeaderData/w?Debtflag=&scripcode=${bseCode}&seriesid=`,
    { headers: BSE_HEADERS }
  );
  if (!quoteRes.ok) throw new Error(`BSE quote fetch failed: ${quoteRes.status}`);
  const quote = await quoteRes.json();
  const header = quote?.Header || quote; // BSE's response shape has varied across their own site versions

  const price = parseFloat(header?.LTP ?? header?.CurrRate ?? header?.LastTradedPrice);
  if (!price || isNaN(price)) throw new Error("BSE returned no usable price");

  // 2-year daily graph — BSE's history endpoint doesn't go back as far as
  // NSE's in most cases; 2yr is what's reliably available.
  let history = [];
  try {
    const histRes = await fetch(
      `https://api.bseindia.com/BseIndiaAPI/api/StockReachGraph/w?flag=0&scripcode=${bseCode}&fromdate=&todate=&seriesid=`,
      { headers: BSE_HEADERS }
    );
    if (histRes.ok) {
      const histJson = await histRes.json();
      const points = histJson?.Data ? JSON.parse(histJson.Data) : [];
      history = points
        .map((p) => ({ date: p[0], close: parseFloat(p[1]) }))
        .filter((r) => !isNaN(r.close));
    }
  } catch {
    // history is a bonus, not required — keep going with just today's price if it fails
  }

  return {
    price,
    change: parseFloat(header?.Chg) || null,
    pctChange: parseFloat(header?.PcChng) || null,
    dayHigh: parseFloat(header?.High) || null,
    dayLow: parseFloat(header?.Low) || null,
    history,
    source: "bse",
  };
}

// Yahoo Finance's public chart endpoint — same NSE-listed stock, relayed
// through a well-established third-party aggregator (symbol + ".NS" is
// Yahoo's convention for NSE tickers).
async function fetchFromYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}.NS?range=5y&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": NSE_HEADERS["User-Agent"] } });
  if (!res.ok) throw new Error(`Yahoo fetch failed: ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error("Yahoo returned no data for this symbol");

  const meta = result.meta || {};
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const history = timestamps
    .map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: closes[i] }))
    .filter((r) => typeof r.close === "number" && !isNaN(r.close));

  const price = meta.regularMarketPrice ?? null;
  const prevClose = meta.previousClose ?? null;
  const change = price !== null && prevClose ? price - prevClose : null;
  const pctChange = change !== null && prevClose ? (change / prevClose) * 100 : null;

  return {
    price, change, pctChange,
    dayHigh: meta.regularMarketDayHigh ?? null,
    dayLow: meta.regularMarketDayLow ?? null,
    history,
    source: "yahoo",
  };
}

async function main() {
  const { symbols: rawList } = JSON.parse(readFileSync("watchlist.json", "utf8"));
  // Support both the old plain-string format and the new {symbol, bseCode} format
  const watchlist = rawList.map((entry) => (typeof entry === "string" ? { symbol: entry, bseCode: null } : entry));
  console.log(`Fetching ${watchlist.length} symbols...`);

  let nseCookies = await getNseSessionCookies();
  const out = {};
  const tally = { nse: 0, bse: 0, yahoo: 0, failed: 0 };

  const to = new Date();
  const from = new Date();
  from.setFullYear(from.getFullYear() - 5);

  for (const { symbol, bseCode } of watchlist) {
    let done = false;

    // Tier 1: NSE, twice, refreshing the session between attempts
    for (let attempt = 1; attempt <= 2 && !done; attempt++) {
      try {
        out[symbol] = await fetchFromNse(symbol, nseCookies, from, to);
        console.log(`  ✓ ${symbol} (nse): ₹${out[symbol].price}, ${out[symbol].history.length} history points`);
        tally.nse++;
        done = true;
      } catch (err) {
        console.warn(`  ✗ ${symbol} NSE attempt ${attempt} failed: ${err.message}`);
        nseCookies = await getNseSessionCookies();
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    // Tier 2: BSE, only if this symbol has a bseCode configured
    if (!done && bseCode) {
      try {
        out[symbol] = await fetchFromBse(bseCode);
        console.log(`  ✓ ${symbol} (bse): ₹${out[symbol].price}, ${out[symbol].history.length} history points`);
        tally.bse++;
        done = true;
      } catch (err) {
        console.warn(`  ✗ ${symbol} BSE (scrip ${bseCode}) failed: ${err.message}`);
      }
    }

    // Tier 3: Yahoo Finance, last resort
    if (!done) {
      try {
        out[symbol] = await fetchFromYahoo(symbol);
        console.log(`  ✓ ${symbol} (yahoo fallback): ₹${out[symbol].price}, ${out[symbol].history.length} history points`);
        tally.yahoo++;
        done = true;
      } catch (err) {
        console.warn(`  ✗✗ ${symbol} ALL sources failed (last error: ${err.message}) — missing from stocks.json this run`);
        tally.failed++;
      }
    }

    await new Promise((r) => setTimeout(r, 800));
  }

  mkdirSync("data", { recursive: true });
  writeFileSync("data/stocks.json", JSON.stringify(out));
  console.log(`Wrote data/stocks.json — ${tally.nse} from NSE, ${tally.bse} from BSE, ${tally.yahoo} from Yahoo, ${tally.failed} failed entirely`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

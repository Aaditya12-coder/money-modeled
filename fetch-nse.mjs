// fetch-nse.mjs
// Pulls live quotes + 5-year daily history straight from NSE's own site
// endpoints (the same ones nseindia.com's web UI calls). There is no official
// public API or key for this — NSE only trusts requests that look like they
// came from a real browser session, so we first load the homepage to collect
// session cookies, then reuse those cookies on the data endpoints.
//
// This is inherently a bit fragile: NSE can change endpoint shapes or
// tighten bot-detection at any time without notice. If a symbol keeps
// failing on NSE specifically, this script now falls back to Yahoo Finance's
// chart endpoint for that symbol (still NSE-listed data, just relayed
// through Yahoo rather than nseindia.com directly) so a temperamental NSE
// response doesn't mean that stock just silently vanishes from your data.
//
// Output: data/stocks.json
//   { "<SYMBOL>": { price, change, pctChange, dayHigh, dayLow, history: [{date, close}], source } }
//
// Run with: node fetch-nse.mjs

import { writeFileSync, mkdirSync, readFileSync } from "fs";

const BASE = "https://www.nseindia.com";
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.nseindia.com/",
};

// Simple in-memory cookie jar
function extractCookies(res) {
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return setCookie.map((c) => c.split(";")[0]).join("; ");
}

async function getSessionCookies() {
  const res = await fetch(BASE, { headers: HEADERS });
  return extractCookies(res);
}

async function nseFetch(path, cookies) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { ...HEADERS, Cookie: cookies },
  });
  if (!res.ok) throw new Error(`NSE fetch failed for ${path}: ${res.status}`);
  return res.json();
}

function fmtDate(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${d.getFullYear()}`;
}

async function fetchFromNse(symbol, cookies, from, to) {
  const quote = await nseFetch(`/api/quote-equity?symbol=${encodeURIComponent(symbol)}`, cookies);
  const priceInfo = quote.priceInfo || {};

  const hist = await nseFetch(
    `/api/historical/cm/equity?symbol=${encodeURIComponent(symbol)}&series=["EQ"]&from=${fmtDate(from)}&to=${fmtDate(to)}`,
    cookies
  );
  const history = (hist.data || [])
    .map((row) => ({ date: row.CH_TIMESTAMP, close: parseFloat(row.CH_CLOSING_PRICE) }))
    .filter((r) => !isNaN(r.close))
    .reverse(); // oldest first

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

// Fallback path: Yahoo Finance's public chart endpoint, still fetching the
// same NSE-listed stock (symbol + ".NS" suffix is Yahoo's convention for
// NSE tickers) — used only when NSE itself has repeatedly refused a symbol.
async function fetchFromYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}.NS?range=5y&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": HEADERS["User-Agent"] } });
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
  const { symbols } = JSON.parse(readFileSync("watchlist.json", "utf8"));
  console.log(`Fetching ${symbols.length} symbols...`);

  let cookies = await getSessionCookies();
  const out = {};
  let nseCount = 0, yahooCount = 0, failCount = 0;

  const to = new Date();
  const from = new Date();
  from.setFullYear(from.getFullYear() - 5);

  for (const symbol of symbols) {
    let done = false;

    // Try NSE directly, twice, refreshing the session between attempts
    for (let attempt = 1; attempt <= 2 && !done; attempt++) {
      try {
        out[symbol] = await fetchFromNse(symbol, cookies, from, to);
        console.log(`  ✓ ${symbol} (nse): ₹${out[symbol].price}, ${out[symbol].history.length} history points`);
        nseCount++;
        done = true;
      } catch (err) {
        console.warn(`  ✗ ${symbol} NSE attempt ${attempt} failed: ${err.message}`);
        cookies = await getSessionCookies();
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    // NSE refused twice — fall back to Yahoo for this one symbol only
    if (!done) {
      try {
        out[symbol] = await fetchFromYahoo(symbol);
        console.log(`  ✓ ${symbol} (yahoo fallback): ₹${out[symbol].price}, ${out[symbol].history.length} history points`);
        yahooCount++;
        done = true;
      } catch (err) {
        console.warn(`  ✗✗ ${symbol} Yahoo fallback also failed: ${err.message} — this symbol will be missing from stocks.json this run`);
        failCount++;
      }
    }

    // be polite — avoid hammering either source
    await new Promise((r) => setTimeout(r, 800));
  }

  mkdirSync("data", { recursive: true });
  writeFileSync("data/stocks.json", JSON.stringify(out));
  console.log(`Wrote data/stocks.json — ${nseCount} from NSE, ${yahooCount} from Yahoo fallback, ${failCount} failed entirely`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

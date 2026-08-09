// fetch-nse.mjs
// Pulls live quotes + 5-year daily history straight from NSE's own site
// endpoints (the same ones nseindia.com's web UI calls). There is no official
// public API or key for this — NSE only trusts requests that look like they
// came from a real browser session, so we first load the homepage to collect
// session cookies, then reuse those cookies on the data endpoints.
//
// This is inherently a bit fragile: NSE can change endpoint shapes or
// tighten bot-detection at any time without notice. If this script starts
// failing, check nseindia.com's network tab in a real browser to see what
// changed, and update the headers/paths below.
//
// Output: data/stocks.json
//   { "<SYMBOL>": { price, change, pctChange, dayHigh, dayLow, history: [{date, close}] }, ... }
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

async function main() {
  const { symbols } = JSON.parse(readFileSync("watchlist.json", "utf8"));
  console.log(`Fetching ${symbols.length} symbols from NSE...`);

  let cookies = await getSessionCookies();
  const out = {};

  const to = new Date();
  const from = new Date();
  from.setFullYear(from.getFullYear() - 5);

  for (const symbol of symbols) {
    try {
      // Live quote
      const quote = await nseFetch(`/api/quote-equity?symbol=${encodeURIComponent(symbol)}`, cookies);
      const priceInfo = quote.priceInfo || {};

      // 5-year daily history (used later for CAGR / trend stats on the site)
      const hist = await nseFetch(
        `/api/historical/cm/equity?symbol=${encodeURIComponent(symbol)}&series=["EQ"]&from=${fmtDate(from)}&to=${fmtDate(to)}`,
        cookies
      );
      const history = (hist.data || [])
        .map((row) => ({ date: row.CH_TIMESTAMP, close: parseFloat(row.CH_CLOSING_PRICE) }))
        .filter((r) => !isNaN(r.close))
        .reverse(); // oldest first

      out[symbol] = {
        price: priceInfo.lastPrice ?? null,
        change: priceInfo.change ?? null,
        pctChange: priceInfo.pChange ?? null,
        dayHigh: priceInfo.intraDayHighLow?.max ?? null,
        dayLow: priceInfo.intraDayHighLow?.min ?? null,
        history,
      };
      console.log(`  ✓ ${symbol}: ₹${priceInfo.lastPrice}, ${history.length} history points`);
    } catch (err) {
      console.warn(`  ✗ ${symbol} failed: ${err.message}`);
      // refresh session in case cookies expired mid-run
      cookies = await getSessionCookies();
    }
    // be polite — avoid hammering NSE and tripping rate limits
    await new Promise((r) => setTimeout(r, 800));
  }

  mkdirSync("data", { recursive: true });
  writeFileSync("data/stocks.json", JSON.stringify(out));
  console.log(`Wrote data/stocks.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// fetch-amfi.mjs
// Pulls the official, free, daily NAV file published by AMFI (Association of
// Mutual Funds in India) — this is the primary source every fund house
// reports to, not a third-party scrape. No API key needed.
//
// ALSO pulls historical NAV snapshots (1/2/3/4/5 years ago) for every scheme,
// using AMFI's historical NAV report endpoint, so the site can compute a real
// CAGR for mutual funds the same way it already does for stocks — instead of
// requiring you to type in a guessed return rate.
//
// Honesty note: unlike the daily NAVAll.txt file (which is AMFI's well-known,
// widely-used public endpoint), the historical report endpoint below is
// reverse-engineered from AMFI's own website — there's no official published
// API contract for it. It has worked reliably for this kind of use in the
// wider community, but if AMFI changes it, only the "historical" part of this
// script will start failing — the daily NAV part is independent and will keep
// working regardless.
//
// Output: data/mutual-funds.json
//   { "<schemeCode>": { name, category, isinGrowth, isinDiv, nav, date,
//                        history: [{date, close}, ...] }, ... }
//   (history is oldest-first, sparse — only the years that had usable data)
//
// Run with: node fetch-amfi.mjs

import { writeFileSync, mkdirSync } from "fs";

const AMFI_URL = "https://www.amfiindia.com/spages/NAVAll.txt";
const HISTORY_URL = "https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx";
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; money-modeled-bot/1.0)" };

function parseNavText(text) {
  const lines = text.split("\n");
  const out = {};
  let currentCategory = "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Category header lines look like "Open Ended Schemes(Equity Scheme)"
    // — no semicolons, so treat any semicolon-free non-empty line as a header.
    if (!line.includes(";")) {
      currentCategory = line;
      continue;
    }

    // Data lines: Scheme Code;ISIN Div Payout/Growth;ISIN Div Reinvestment;
    //             Scheme Name;Net Asset Value;Date
    const parts = line.split(";");
    if (parts.length < 6) continue;
    const [schemeCode, isinGrowth, isinDiv, name, navStr, date] = parts;
    const nav = parseFloat(navStr);
    if (!schemeCode.trim() || isNaN(nav)) continue;

    out[schemeCode.trim()] = {
      name: name.trim(),
      category: currentCategory,
      isinGrowth: isinGrowth.trim() || null,
      isinDiv: isinDiv.trim() || null,
      nav,
      date: date.trim(),
    };
  }
  return out;
}

function fmtDate(d) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(d.getDate()).padStart(2, "0")}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

// Fetches a small window of days ending at `targetDate` (going backward),
// not just one exact day — AMFI has no NAV on weekends/holidays, so a single
// exact date very often returns nothing. Returns the FIRST (closest-to-target)
// scheme entry found within the window.
async function fetchHistoricalWindow(targetDate) {
  const to = new Date(targetDate);
  const from = new Date(targetDate);
  from.setDate(from.getDate() - 6); // look back up to a week for a trading day

  const url = `${HISTORY_URL}?frmdt=${fmtDate(from)}&todt=${fmtDate(to)}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`historical fetch failed: ${res.status}`);
  const text = await res.text();

  // Same pipe/semicolon-delimited shape as the daily file, but may contain
  // several dates' worth of rows per scheme within the window — keep only
  // the LAST one seen per scheme code (closest to `to`, since AMFI lists
  // rows oldest-first within a range in every version of this report we've
  // seen; if that assumption turns out wrong for your data, each scheme's
  // history array is still internally date-sorted before use, so a few
  // out-of-order raw rows won't break the final CAGR math).
  const parsed = parseNavText(text);
  const byScheme = {};
  for (const [code, entry] of Object.entries(parsed)) {
    // AMFI's historical endpoint has been observed returning a blank date
    // column even when the NAV value itself is valid — rather than throw
    // that data point away, fall back to the target date we know we
    // requested (accurate to within the ~6-day lookback window, which is
    // precise enough for a multi-year CAGR).
    const dateIsUsable = entry.date && !isNaN(new Date(entry.date).getTime());
    byScheme[code] = { date: dateIsUsable ? entry.date : fmtDate(to), close: entry.nav };
  }
  return byScheme;
}

async function main() {
  console.log("Fetching AMFI daily NAV file...");
  const res = await fetch(AMFI_URL, { headers: HEADERS });
  if (!res.ok) throw new Error(`AMFI fetch failed: ${res.status} ${res.statusText}`);
  const today = parseNavText(await res.text());
  console.log(`  ✓ ${Object.keys(today).length} schemes`);

  // Historical snapshots — best effort. If AMFI's historical endpoint is
  // unavailable or its shape has changed, we log a warning and continue
  // with whatever years succeeded (possibly zero) rather than failing the
  // whole run — the daily prices are the important part and must not be
  // blocked by this.
  const now = new Date();
  const yearsAgo = [1, 2, 3, 4, 5];
  const historyByYear = {};

  for (const y of yearsAgo) {
    const target = new Date(now);
    target.setFullYear(target.getFullYear() - y);
    try {
      console.log(`Fetching historical NAV window for ~${y}yr ago (${fmtDate(target)})...`);
      historyByYear[y] = await fetchHistoricalWindow(target);
      console.log(`  ✓ got ${Object.keys(historyByYear[y]).length} scheme entries`);
    } catch (err) {
      console.warn(`  ✗ ${y}yr-ago fetch failed: ${err.message} — skipping this year, continuing`);
      historyByYear[y] = {};
    }
    // be polite between requests
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Merge: for every scheme in today's file, attach whatever historical
  // points we successfully found, oldest first.
  let withHistory = 0;
  for (const code of Object.keys(today)) {
    const points = [];
    for (const y of yearsAgo) {
      const entry = historyByYear[y][code];
      // Reject any entry with a missing/unparseable date — AMFI's historical
      // endpoint doesn't always return a usable date on every column, and a
      // corrupted date silently breaks CAGR math downstream (NaN) rather
      // than failing loudly, so we filter it out here instead.
      const validDate = entry && entry.date && !isNaN(new Date(entry.date).getTime());
      if (entry && entry.close > 0 && validDate) points.push(entry);
    }
    points.push({ date: today[code].date, close: today[code].nav });
    points.sort((a, b) => new Date(a.date) - new Date(b.date));
    // de-duplicate same-date entries that can happen if a window overlapped
    const seen = new Set();
    today[code].history = points.filter((p) => (seen.has(p.date) ? false : (seen.add(p.date), true)));
    if (today[code].history.length >= 2) withHistory++;
  }

  mkdirSync("data", { recursive: true });
  writeFileSync("data/mutual-funds.json", JSON.stringify(today));
  console.log(`Wrote ${Object.keys(today).length} schemes to data/mutual-funds.json (${withHistory} with usable history for CAGR)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

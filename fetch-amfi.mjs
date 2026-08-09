// fetch-amfi.mjs
// Pulls the official, free, daily NAV file published by AMFI (Association of
// Mutual Funds in India) — this is the primary source every fund house
// reports to, not a third-party scrape. No API key needed.
//
// Output: data/mutual-funds.json
//   { "<schemeCode>": { name, isinGrowth, isinDiv, nav, date }, ... }
//
// Run with: node fetch-amfi.mjs

import { writeFileSync, mkdirSync } from "fs";

const AMFI_URL = "https://www.amfiindia.com/spages/NAVAll.txt";

async function main() {
  console.log("Fetching AMFI NAV file...");
  const res = await fetch(AMFI_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; money-modeled-bot/1.0)" },
  });
  if (!res.ok) throw new Error(`AMFI fetch failed: ${res.status} ${res.statusText}`);
  const text = await res.text();

  const lines = text.split("\n");
  const out = {};
  let currentCategory = "";
  let count = 0;

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
    if (!schemeCode || isNaN(nav)) continue;

    out[schemeCode.trim()] = {
      name: name.trim(),
      category: currentCategory,
      isinGrowth: isinGrowth.trim() || null,
      isinDiv: isinDiv.trim() || null,
      nav,
      date: date.trim(),
    };
    count++;
  }

  mkdirSync("data", { recursive: true });
  writeFileSync("data/mutual-funds.json", JSON.stringify(out));
  console.log(`Wrote ${count} schemes to data/mutual-funds.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

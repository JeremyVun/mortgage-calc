#!/usr/bin/env node
// One-packet size smoke test for the built single-file page.
//
// WHY: TCP slow start lets a server send ~10 segments (RFC 6928 initcwnd) in the
// first round trip before it must wait for an ACK. At a ~1460-byte MSS that is
// ~14,600 bytes. Keep the COMPRESSED page under that and the whole document
// lands in a single RTT on a cold connection — no second round trip from slow
// start. We serve brotli (see default.conf.template), so the brotli size is the
// real on-the-wire transfer size and the figure we gate on; gzip is reported for
// reference (older clients) but does not fail the build.
//
// USAGE:
//   npm run size            human-readable report; exit 1 if over budget
//   npm run size -- --json  machine-readable JSON (for CI dashboards)
//
// This is intentionally dependency-free: gzip and brotli both come from Node's
// built-in zlib, so any checkout can run it without installing anything.

import { readFileSync } from "node:fs";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = resolve(ROOT, "dist/index.html");

// The one-packet budget. ~14,600 is the theoretical initcwnd ceiling; we gate at
// a round 14 KB and warn (without failing) once we cross a comfortable 13 KB,
// leaving headroom for TLS record overhead on the first flight.
const BUDGET = 14 * 1024; // 14336 — hard gate (brotli must be at or under this)
const COMFORT = 13 * 1024; // 13312 — soft line; warn between here and BUDGET

const gzip = (buf) => gzipSync(buf, { level: 9 }).length;
const brotli = (buf) =>
  brotliCompressSync(buf, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
    },
  }).length;

const json = process.argv.includes("--json");

let html;
try {
  html = readFileSync(FILE);
} catch {
  console.error(`✗ ${FILE} not found.\n  Run \`npm run build\` first, then re-run \`npm run size\`.`);
  process.exit(2);
}
const text = html.toString("utf8");

// Split the single file into its three contributors. Sections are compressed
// standalone, so their sum is slightly larger than the whole file (the whole
// file shares one compression dictionary across all three) — that gap is
// reported so the numbers stay honest.
const join = (re) => [...text.matchAll(re)].map((m) => m[1]).join("");
const css = join(/<style[^>]*>([\s\S]*?)<\/style>/g);
const js = join(/<script[^>]*>([\s\S]*?)<\/script>/g);
const markup = text
  .replace(/<style[^>]*>[\s\S]*?<\/style>/g, "")
  .replace(/<script[^>]*>[\s\S]*?<\/script>/g, "");

const measure = (label, str) => {
  const buf = Buffer.from(str, "utf8");
  return { label, raw: buf.length, gzip: gzip(buf), brotli: brotli(buf) };
};

const sections = [
  measure("CSS   <style>", css),
  measure("JS    <script>", js),
  measure("HTML  markup", markup),
];
const whole = { label: "WHOLE FILE", raw: html.length, gzip: gzip(html), brotli: brotli(html) };

const overBudget = whole.brotli > BUDGET;

if (json) {
  console.log(
    JSON.stringify(
      { file: FILE, budget: BUDGET, comfort: COMFORT, whole, sections, pass: !overBudget },
      null,
      2,
    ),
  );
  process.exit(overBudget ? 1 : 0);
}

// ---- human report ----
const kb = (n) => (n / 1024).toFixed(1).padStart(5) + " KB";
const pct = (n) => String(Math.round((100 * n) / whole.brotli)).padStart(3) + "%";
const row = (r, share) =>
  `${r.label.padEnd(14)} ${String(r.raw).padStart(7)} ${kb(r.gzip)}  ${kb(r.brotli)}` +
  (share ? `   ${pct(r.brotli)} of br` : "");

console.log("\n  One-packet size budget — dist/index.html\n");
console.log(`  ${"section".padEnd(14)} ${"raw".padStart(7)} ${"gzip".padStart(8)}  ${"brotli".padStart(8)}`);
console.log("  " + "-".repeat(52));
for (const s of sections) console.log("  " + row(s, true));
console.log("  " + "-".repeat(52));
console.log("  " + row(whole, false));

const delta = whole.brotli - BUDGET;
console.log("");
if (overBudget) {
  console.log(`  ✗ OVER budget: brotli ${kb(whole.brotli).trim()} vs ${kb(BUDGET).trim()} target`);
  console.log(`    need to shave ${(delta / 1024).toFixed(1)} KB of brotli to land in one packet`);
} else if (whole.brotli > COMFORT) {
  console.log(`  ⚠ Within budget but tight: brotli ${kb(whole.brotli).trim()} (< ${kb(BUDGET).trim()}, > ${kb(COMFORT).trim()} comfort line)`);
} else {
  console.log(`  ✓ One packet: brotli ${kb(whole.brotli).trim()} ≤ ${kb(BUDGET).trim()} target`);
}
console.log("");

process.exit(overBudget ? 1 : 0);

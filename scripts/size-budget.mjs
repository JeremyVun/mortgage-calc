#!/usr/bin/env node
// Size report for the built single-file page: one-packet budget gate (default)
// plus an optional per-source-module JS drill-down (`--js`).
//
// These two views answer adjacent questions, so they live in one tool:
//   • the BUDGET — is the COMPRESSED page small enough to land in one TCP packet?
//   • the JS DRILL-DOWN — when JS dominates that weight, WHICH src module costs it?
//
// ── one-packet budget (default; the CI gate) ────────────────────────────────
// WHY: TCP slow start lets a server send ~10 segments (RFC 6928 initcwnd) in the
// first round trip before it must wait for an ACK. At a ~1460-byte MSS that is
// ~14,600 bytes. Keep the COMPRESSED page under that and the whole document
// lands in a single RTT on a cold connection — no second round trip from slow
// start. We serve brotli (see default.conf.template), so the brotli size is the
// real on-the-wire transfer size and the figure we gate on; gzip is reported for
// reference (older clients) but does not fail the build. Reads the built
// dist/index.html — run `npm run build` first.
//
// ── JS per-module profile (`--js`) ──────────────────────────────────────────
// WHY: the production bundle is minified and inlined into one <script>, so the
// module boundaries are gone — the budget can tell you JS is ~55% of the
// compressed page, but not WHICH source module costs that. This attributes the
// minified bytes back to each src/*.js file using esbuild's metafile
// (`bytesInOutput` = bytes from that input that survived tree-shaking + minify).
// It bundles src/main.js in-memory with esbuild (already a Vite dependency, so no
// new install) — a faithful proxy for the shipped Rollup+esbuild bundle. The
// minified TOTAL lands within a few hundred bytes of the real one, and the
// per-module PROPORTIONS are what matter for deciding where to cut. Reads src/
// directly, so no prior `npm run build` is needed.
//
// USAGE:
//   npm run size               budget report + gate (exit 1 if over) + JS drill-down
//   npm run size -- --json     combined machine-readable JSON (for CI dashboards)
//   npm run profile:js         JS per-module profile only (= --js; no build needed)
//   npm run profile:js -- --json
//
// The budget is intentionally dependency-free (gzip/brotli come from Node's
// built-in zlib); only the JS profile reaches for esbuild, and it does so lazily
// so the gate still runs if esbuild is ever absent.

import { readFileSync } from "node:fs";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { fileURLToPath } from "node:url";
import { resolve, dirname, relative } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = resolve(ROOT, "dist/index.html");
const ENTRY = resolve(ROOT, "src/main.js");

// The one-packet budget. ~14,600 is the theoretical initcwnd ceiling; we gate at
// a round 14 KB and warn (without failing) once we cross a comfortable 13 KB,
// leaving headroom for TLS record overhead on the first flight.
const BUDGET = 14 * 1024; // 14336 — hard gate (brotli must be at or under this)
const COMFORT = 13 * 1024; // 13312 — soft line; warn between here and BUDGET

// ---- shared helpers ----
const gzip = (buf) => gzipSync(buf, { level: 9 }).length;
const brotli = (buf) =>
  brotliCompressSync(buf, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
    },
  }).length;
const kb = (n) => (n / 1024).toFixed(1).padStart(5) + " KB";

// ---- budget: measure the built dist/index.html ----
// Returns null if the file isn't built yet (caller turns that into exit 2).
function measureBudget() {
  let html;
  try {
    html = readFileSync(DIST);
  } catch {
    return null;
  }
  const text = html.toString("utf8");

  // Split the single file into its three contributors. Sections are compressed
  // standalone, so their sum is slightly larger than the whole file (the whole
  // file shares one compression dictionary across all three) — that gap is the
  // price of the per-section attribution, and the WHOLE FILE row is the truth.
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

  return { file: DIST, whole, sections, overBudget: whole.brotli > BUDGET };
}

// ---- JS profile: bundle src in-memory, attribute minified bytes per module ----
async function profileJs() {
  const { build } = await import("esbuild");

  // Bundle exactly as production does (modulo Rollup vs esbuild): one
  // self-contained minified script targeting es2020, unicode kept literal so
  // sizes are realistic.
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    minify: true,
    format: "iife",
    target: "es2020",
    charset: "utf8",
    legalComments: "none",
    // main.js imports styles.css for the dev/build pipeline; the CSS is profiled
    // separately by the budget view, so drop it here to keep this JS-only.
    loader: { ".css": "empty" },
    metafile: true,
    write: false,
  });

  const out = result.outputFiles[0];
  const outBytes = Buffer.from(out.contents);
  const meta = Object.values(result.metafile.outputs)[0];

  // metafile input paths are relative to cwd; normalise to repo-relative.
  const modules = Object.entries(meta.inputs)
    .map(([path, info]) => ({
      module: relative(ROOT, resolve(process.cwd(), path)).replace(/^(\.\.\/)+/, ""),
      minBytes: info.bytesInOutput,
    }))
    .filter((m) => m.minBytes > 0)
    .sort((a, b) => b.minBytes - a.minBytes);

  const totalMin = modules.reduce((n, m) => n + m.minBytes, 0);
  const wholeBr = brotli(outBytes);
  const wholeGz = gzip(outBytes);

  // Per-module brotli isn't well-defined (shared dictionary), so estimate each
  // module's brotli contribution by its share of the minified bytes. Clearly
  // labelled as an estimate; minBytes is the precise, authoritative figure.
  for (const m of modules) {
    m.share = m.minBytes / totalMin;
    m.estBr = Math.round(m.share * wholeBr);
  }

  return {
    entry: "src/main.js",
    bundle: { minified: outBytes.length, gzip: wholeGz, brotli: wholeBr },
    totalMin,
    modules,
  };
}

// ---- human rendering ----
function printBudget(b) {
  const pct = (n) => String(Math.round((100 * n) / b.whole.brotli)).padStart(3) + "%";
  const row = (r, share) =>
    `${r.label.padEnd(14)} ${String(r.raw).padStart(7)} ${kb(r.gzip)}  ${kb(r.brotli)}` +
    (share ? `   ${pct(r.brotli)} of br` : "");

  console.log("\n  One-packet size budget — dist/index.html\n");
  console.log(`  ${"section".padEnd(14)} ${"raw".padStart(7)} ${"gzip".padStart(8)}  ${"brotli".padStart(8)}`);
  console.log("  " + "-".repeat(52));
  for (const s of b.sections) console.log("  " + row(s, true));
  console.log("  " + "-".repeat(52));
  console.log("  " + row(b.whole, false));

  const delta = b.whole.brotli - BUDGET;
  console.log("");
  if (b.overBudget) {
    console.log(`  ✗ OVER budget: brotli ${kb(b.whole.brotli).trim()} vs ${kb(BUDGET).trim()} target`);
    console.log(`    need to shave ${(delta / 1024).toFixed(1)} KB of brotli to land in one packet`);
  } else if (b.whole.brotli > COMFORT) {
    console.log(`  ⚠ Within budget but tight: brotli ${kb(b.whole.brotli).trim()} (< ${kb(BUDGET).trim()}, > ${kb(COMFORT).trim()} comfort line)`);
  } else {
    console.log(`  ✓ One packet: brotli ${kb(b.whole.brotli).trim()} ≤ ${kb(BUDGET).trim()} target`);
  }
  console.log("");
}

function printJsProfile(p) {
  const kbp = (n) => (n / 1024).toFixed(1).padStart(5) + " KB";
  const pct = (s) => String(Math.round(100 * s)).padStart(3) + "%";

  console.log("  JS per-module profile  (minified bytes attributed via esbuild metafile)\n");
  console.log(`  ${"module".padEnd(18)} ${"min".padStart(7)} ${"share".padStart(6)} ${"~brotli".padStart(8)}`);
  console.log("  " + "-".repeat(46));
  for (const m of p.modules) {
    console.log(`  ${m.module.padEnd(18)} ${String(m.minBytes).padStart(7)} ${pct(m.share)}   ${kbp(m.estBr)}`);
  }
  console.log("  " + "-".repeat(46));
  console.log(`  ${"BUNDLE".padEnd(18)} ${String(p.totalMin).padStart(7)} ${" 100%"}   ${kbp(p.bundle.brotli)}`);
  console.log("");
  console.log(`  profiling bundle: ${(p.bundle.minified / 1024).toFixed(1)} KB min · ${kbp(p.bundle.gzip).trim()} gzip · ${kbp(p.bundle.brotli).trim()} brotli`);
  console.log(`  (~brotli per module is estimated by minified-byte share; min bytes are exact)`);
  console.log("");
}

// ---- main ----
const argv = process.argv.slice(2);
const json = argv.includes("--json");
const jsOnly = argv.includes("--js");

// `--js` (npm run profile:js): JS per-module profile only. No build needed.
if (jsOnly) {
  let p;
  try {
    p = await profileJs();
  } catch (e) {
    console.error(`✗ JS profile failed: ${e.message}`);
    process.exit(1);
  }
  if (json) {
    console.log(JSON.stringify({ entry: p.entry, bundle: p.bundle, modules: p.modules }, null, 2));
  } else {
    console.log("");
    printJsProfile(p);
  }
  process.exit(0);
}

// Default (npm run size): the one-packet budget gate, with the JS drill-down
// appended. The budget needs the built dist; bail clearly if it's missing.
const b = measureBudget();
if (!b) {
  if (json) {
    console.log(JSON.stringify({ file: DIST, error: "not-built" }, null, 2));
  } else {
    console.error(`✗ ${DIST} not found.\n  Run \`npm run build\` first, then re-run \`npm run size\`.`);
  }
  process.exit(2);
}

// The JS drill-down is best-effort: it must never flip the gate's exit code, so
// failures (e.g. esbuild absent) degrade to a skipped section, not a hard error.
let p = null;
try {
  p = await profileJs();
} catch {
  p = null;
}

if (json) {
  console.log(
    JSON.stringify(
      {
        file: b.file,
        budget: BUDGET,
        comfort: COMFORT,
        whole: b.whole,
        sections: b.sections,
        pass: !b.overBudget,
        js: p && { entry: p.entry, bundle: p.bundle, modules: p.modules },
      },
      null,
      2,
    ),
  );
  process.exit(b.overBudget ? 1 : 0);
}

printBudget(b);
if (p) printJsProfile(p);
else console.log("  (JS per-module profile skipped — esbuild unavailable)\n");

process.exit(b.overBudget ? 1 : 0);

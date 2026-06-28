#!/usr/bin/env node
// Per-source-module profile of the shipped JS.
//
// WHY: the production bundle is minified and inlined into one <script>, so the
// module boundaries are gone — `npm run size` can tell you JS is ~55% of the
// compressed page, but not WHICH source module costs that. This attributes the
// minified bytes back to each src/*.js file using esbuild's metafile
// (`bytesInOutput` = bytes from that input that survived tree-shaking + minify).
//
// It bundles src/main.js in-memory with esbuild (already a Vite dependency, so no
// new install) — a faithful proxy for the shipped Rollup+esbuild bundle. The
// minified TOTAL here lands within a few hundred bytes of the real bundle, and
// the per-module PROPORTIONS are what matter for deciding where to cut.
//
// USAGE:
//   npm run profile:js            human-readable report
//   npm run profile:js -- --json  machine-readable JSON
//
// Re-runnable: reads src/ directly, no prior `npm run build` needed.

import { build } from "esbuild";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { fileURLToPath } from "node:url";
import { resolve, dirname, relative } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = resolve(ROOT, "src/main.js");

const brotli = (buf) =>
  brotliCompressSync(buf, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
    },
  }).length;
const gzip = (buf) => gzipSync(buf, { level: 9 }).length;

// Bundle exactly as production does (modulo Rollup vs esbuild): one self-contained
// minified script targeting es2020, unicode kept literal so sizes are realistic.
const result = await build({
  entryPoints: [ENTRY],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2020",
  charset: "utf8",
  legalComments: "none",
  // main.js imports styles.css for the dev/build pipeline; the CSS is profiled
  // separately by `npm run size`, so drop it here to keep this JS-only.
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

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      { entry: "src/main.js", bundle: { minified: outBytes.length, gzip: wholeGz, brotli: wholeBr }, modules },
      null,
      2,
    ),
  );
  process.exit(0);
}

const kb = (n) => (n / 1024).toFixed(1).padStart(5) + " KB";
const pct = (s) => String(Math.round(100 * s)).padStart(3) + "%";

console.log("\n  JS per-module profile  (minified bytes attributed via esbuild metafile)\n");
console.log(`  ${"module".padEnd(18)} ${"min".padStart(7)} ${"share".padStart(6)} ${"~brotli".padStart(8)}`);
console.log("  " + "-".repeat(46));
for (const m of modules) {
  console.log(`  ${m.module.padEnd(18)} ${String(m.minBytes).padStart(7)} ${pct(m.share)}   ${kb(m.estBr)}`);
}
console.log("  " + "-".repeat(46));
console.log(`  ${"BUNDLE".padEnd(18)} ${String(totalMin).padStart(7)} ${" 100%"}   ${kb(wholeBr)}`);
console.log("");
console.log(`  profiling bundle: ${(outBytes.length / 1024).toFixed(1)} KB min · ${kb(wholeGz).trim()} gzip · ${kb(wholeBr).trim()} brotli`);
console.log(`  (~brotli per module is estimated by minified-byte share; min bytes are exact)`);
console.log("");

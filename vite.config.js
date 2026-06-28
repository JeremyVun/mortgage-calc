import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync, brotliCompressSync, constants as zlibConstants } from "node:zlib";

// vite-plugin-singlefile inlines the bundle as a <script type="module"> in <head>.
// Module scripts are DEFERRED — the browser paints the (empty placeholder) DOM first
// and only runs the script afterwards, so on load/reset you see a flash of the empty
// page before the content fills in. The original single-file page avoided this with a
// CLASSIC, render-blocking <script> at the very end of <body>: it executes during
// parsing, BEFORE the first paint, so the first frame already shows the populated UI.
//
// This plugin reproduces that. After singlefile has inlined everything, it moves the
// inlined script to the end of <body> and drops type="module" (the bundle has no
// top-level import/export, so it runs fine as a classic script). Build-only hook —
// dev (npm run dev) is untouched.
function classicBlockingScript() {
  let outFile = "dist/index.html";
  return {
    name: "classic-blocking-script",
    apply: "build",
    configResolved(cfg) { outFile = resolve(cfg.root, cfg.build.outDir, "index.html"); },
    closeBundle() {
      let html;
      try { html = readFileSync(outFile, "utf8"); } catch { return; }
      const m = html.match(/<script type="module"[^>]*>([\s\S]*?)<\/script>\s*/);
      if (!m) return; // nothing to move (plugin/output shape changed) — leave as-is
      const code = m[1];
      html = html.replace(m[0], ""); // remove the deferred module from <head>
      // Re-insert as a classic, render-blocking script at the end of <body>. Use a
      // function replacement so '$' sequences in the code aren't treated as $-patterns.
      html = html.replace("</body>", () => `<script>"use strict";\n${code}\n</script>\n</body>`);
      writeFileSync(outFile, html);
    },
  };
}

// After the final index.html is written, emit precompressed siblings so nginx can
// serve them with brotli_static / gzip_static — best ratio (brotli q11), zero
// request-time CPU. enforce:"post" so this runs AFTER classicBlockingScript has
// rewritten the file. Keeping the goal in view: the one-packet TCP budget is
// ~14 KB on the wire; `npm run size` gates the build against it.
function precompress() {
  let outFile = "dist/index.html";
  return {
    name: "precompress",
    apply: "build",
    enforce: "post",
    configResolved(cfg) { outFile = resolve(cfg.root, cfg.build.outDir, "index.html"); },
    closeBundle() {
      let buf;
      try { buf = readFileSync(outFile); } catch { return; }
      writeFileSync(outFile + ".gz", gzipSync(buf, { level: 9 }));
      writeFileSync(outFile + ".br", brotliCompressSync(buf, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
          [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buf.length,
        },
      }));
    },
  };
}

// Vite's build.minify only touches JS/CSS — HTML comments pass straight through
// viteSingleFile into dist/index.html. Strip them here so the section markers etc.
// stay in source (editing sanity) but never ship. order:"pre" runs on the author
// HTML *before* the bundle is inlined, so we only ever touch authored comments,
// never anything inside the minified <script>/<style>.
function stripHtmlComments() {
  return {
    name: "strip-html-comments",
    apply: "build",
    transformIndexHtml: {
      order: "pre",
      handler: (html) =>
        html
          .replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*\r?\n/gm, "") // whole-line comments
          .replace(/<!--[\s\S]*?-->/g, ""), // inline leftovers (e.g. statGrid)
    },
  };
}

// Static single-page app. The SOURCE is split into ES modules + styles.css for
// editing sanity, but the BUILD output is one self-contained dist/index.html with the
// JS and CSS inlined — a single request, no HTML -> JS -> CSS waterfall, and (via the
// plugin above) no flash of empty content on load.
//
//   npm run dev      local dev server with HMR (serves the split modules)
//   npm run build    -> dist/index.html (one inlined file; what nginx ships)
//   npm run preview  serve the built file to sanity-check it
export default defineConfig({
  plugins: [stripHtmlComments(), viteSingleFile(), classicBlockingScript(), precompress()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
  },
});

// Build-time CSS class-name minifier for the single-file build.
//
// Renames every class to a short token (.a, .b, …) CONSISTENTLY across the inlined
// <style>, the HTML body, and the inlined JS — so the SOURCE keeps semantic names
// (.bp-field, .src-row) while the SHIPPED file ships .a/.b/…. Runs on the final
// dist/index.html (after singlefile + classicBlockingScript, before precompress).
//
// ── Safety model ────────────────────────────────────────────────────────────
// A class only takes effect from a handful of STRUCTURAL positions, so those are
// the ONLY places we rewrite:
//   1) class="…"               static HTML + the literal parts of JS template strings
//   2) el.className = …         string literals in the assignment RHS (incl. ternaries)
//   3) el.classList.x("…")      add/remove/toggle/contains/replace — bare class args
//   4) selector strings         closest/querySelector/querySelectorAll/matches: .cls tokens
//   5) CSS selectors            .cls in every <style> block
// Free text (textContent, aria-label, visible copy, data-URIs) is NEVER touched, so
// decoys like `textContent = locked ? "locked" : "solved"` and the `www.w3.org` inside
// the select-chevron SVG are safe by construction.
//
// SKIP: a few classes are produced as data-driven `${tone}` fragments (the stat tone:
// ok/warn/accent) or are glued to an interpolation (stat), so they can't be seen in a
// structural position. They keep their original names. They're short, so the cost is ~0.
//
// LEAK GUARD: after renaming, the structural positions are re-scanned; if any RENAMED
// class's original name survives there, the build FAILS loudly — that means a class is
// used dynamically in a way the passes can't see (make it a complete string literal, or
// add it to SKIP). This makes silent style breakage impossible.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";

const SKIP = new Set(["stat", "ok", "warn", "accent"]);
const CLASS_RE = /^-?[_A-Za-z][\w-]*$/;
const isClass = (t) => t && !t.includes("${") && CLASS_RE.test(t) && !SKIP.has(t);

const brotli = (s) =>
  brotliCompressSync(Buffer.from(s), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: s.length },
  }).length;

// a, b, …, z, A, …, Z, aa, ab, … — skipping any token that equals a real/skip class name
function makeTokens(taken) {
  const al = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let i = 0;
  return () => {
    for (;;) {
      let n = i++, s = al[n % 52];
      n = Math.floor(n / 52);
      while (n > 0) { n--; s = al[n % 52] + s; n = Math.floor(n / 52); }
      if (!taken.has(s)) return s;
    }
  };
}

// ---- regexes for each structural position (shared by collect + rename + guard) ----
const RE_CLASS_ATTR = /\bclass="([^"]*)"/g;
const RE_CLASSLIST  = /(\.classList\.(?:add|remove|toggle|contains|replace)\()([^)]*)(\))/g;
const RE_CLASSNAME  = /\.className\s*=(?!=)\s*/g;  // just the LHS; the RHS is scanned (see scanRHSEnd)
const RE_SELECTOR   = /(\.(?:closest|matches|querySelector|querySelectorAll)\(\s*)(["'`])([\s\S]*?)\2/g;
const RE_STYLE      = /<style[^>]*>[\s\S]*?<\/style>/g;
const RE_STR        = /(["'])([^"']*)\1/g;        // a quoted string literal (no backticks)
const RE_DOTCLASS   = /\.(-?[_A-Za-z][\w-]*)/g;   // a .class token in CSS / selector strings

// Find the end of a `className = …` right-hand side. esbuild chains statements with the
// comma operator (no `;`), so we can't grab "up to the next ;" — that swallows whole
// innerHTML templates. Instead scan the expression, tracking bracket depth + string state,
// and stop at the first top-level `,` `;` or closing bracket. RHS is always a string
// literal or a ternary of string literals, so this bounds it exactly.
function scanRHSEnd(s, i) {
  let depth = 0, q = null;
  for (; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") { if (depth === 0) return i; depth--; }
    else if ((c === "," || c === ";") && depth === 0) return i;
  }
  return s.length;
}

// Walk `.class` tokens in a selector string, SKIPPING ${…} JS interpolations (so a
// property access like `${add.dataset.app}` is never mistaken for a `.dataset` class).
// advance past a ${…} interpolation starting at i (i points at '$'); returns index after '}'
function skipInterp(sel, i) {
  let d = 1; i += 2; // past "${"
  while (i < sel.length && d > 0) { if (sel[i] === "{") d++; else if (sel[i] === "}") d--; i++; }
  return i;
}
function eachSelDot(sel, fn) {
  let i = 0;
  while (i < sel.length) {
    if (sel[i] === "$" && sel[i + 1] === "{") { i = skipInterp(sel, i); continue; }
    const m = /^\.(-?[_A-Za-z][\w-]*)/.exec(sel.slice(i));
    if (m) { fn(m[1]); i += m[0].length; } else i++;
  }
}
function mapSelDot(sel, get) {
  let out = "", i = 0;
  while (i < sel.length) {
    if (sel[i] === "$" && sel[i + 1] === "{") { const j = skipInterp(sel, i); out += sel.slice(i, j); i = j; continue; }
    const m = /^\.(-?[_A-Za-z][\w-]*)/.exec(sel.slice(i));
    if (m) { out += "." + get(m[1]); i += m[0].length; } else { out += sel[i]; i++; }
  }
  return out;
}

// visit each `className = <RHS>` span (RHS bounds via scanRHSEnd)
function eachClassNameRHS(html, cb) {
  RE_CLASSNAME.lastIndex = 0;
  let m;
  while ((m = RE_CLASSNAME.exec(html))) {
    const start = m.index + m[0].length, end = scanRHSEnd(html, start);
    cb(start, end);
    RE_CLASSNAME.lastIndex = end;
  }
}

// walk every class token in every structural position; `fn(name)` per token
function eachClass(html, fn) {
  for (const m of html.matchAll(RE_CLASS_ATTR)) m[1].split(/\s+/).forEach(fn);
  for (const m of html.matchAll(RE_CLASSLIST)) for (const s of m[2].matchAll(RE_STR)) fn(s[2]);
  eachClassNameRHS(html, (a, b) => { for (const s of html.slice(a, b).matchAll(RE_STR)) s[2].split(/\s+/).forEach(fn); });
  for (const m of html.matchAll(RE_SELECTOR)) eachSelDot(m[3], fn);
  for (const blk of html.matchAll(RE_STYLE)) for (const s of blk[0].matchAll(RE_DOTCLASS)) fn(s[1]);
}

function minify(html) {
  // 1) collect class names + occurrence counts from all structural positions
  const counts = new Map();
  eachClass(html, (t) => { if (isClass(t)) counts.set(t, (counts.get(t) || 0) + 1); });

  // 2) assign shortest tokens to the biggest spenders (count × length)
  const taken = new Set([...counts.keys(), ...SKIP]);
  const next = makeTokens(taken);
  const order = [...counts.keys()].sort((a, b) => counts.get(b) * b.length - counts.get(a) * a.length);
  const map = new Map();
  for (const n of order) map.set(n, next());
  const tok = (t) => map.get(t) || t;

  // 3) rewrite each structural position
  let out = html
    // CSS selectors inside every <style> block (only known class names; SVG data-URIs left alone)
    .replace(RE_STYLE, (block) => block.replace(RE_DOTCLASS, (m, n) => (map.has(n) ? "." + map.get(n) : m)))
    // class="…"
    .replace(RE_CLASS_ATTR, (m, v) => 'class="' + v.split(/\s+/).map(tok).join(" ") + '"')
    // el.classList.x("…")
    .replace(RE_CLASSLIST, (m, pre, args, post) => pre + args.replace(RE_STR, (mm, q, v) => q + tok(v) + q) + post)
    // selector strings (.cls tokens only; element/attr/id selectors and ${…} interpolations left alone)
    .replace(RE_SELECTOR, (m, pre, q, sel) => pre + q + mapSelDot(sel, (n) => map.get(n) || n) + q);

  // el.className = <RHS> — rename class tokens inside each quoted string literal of the
  // bounded RHS only (scanner-delimited, so prose/templates after the assignment are untouched)
  {
    let res = "", last = 0;
    eachClassNameRHS(out, (a, b) => {
      res += out.slice(last, a) + out.slice(a, b).replace(RE_STR, (mm, q, v) => q + v.split(/\s+/).map(tok).join(" ") + q);
      last = b;
    });
    out = res + out.slice(last);
  }

  // 4) LEAK GUARD — no renamed original name may survive in any structural position
  const leaks = new Set();
  eachClass(out, (t) => { if (map.has(t)) leaks.add(t); });
  if (leaks.size) {
    throw new Error(
      "[min-classes] original class name(s) survived after rename — used dynamically in a way the " +
      "passes can't see. Make them complete string literals or add to SKIP: " + [...leaks].sort().join(", ")
    );
  }

  return { out, renamed: map.size };
}

export function minClasses() {
  let outFile = "dist/index.html";
  return {
    name: "min-classes",
    apply: "build",
    enforce: "post", // after singlefile/classicBlockingScript; placed before precompress() in the array
    configResolved(cfg) { outFile = resolve(cfg.root, cfg.build.outDir, "index.html"); },
    closeBundle() {
      let html;
      try { html = readFileSync(outFile, "utf8"); } catch { return; }
      const before = brotli(html);
      const { out, renamed } = minify(html);
      writeFileSync(outFile, out);
      const after = brotli(out);
      console.log(`[min-classes] renamed ${renamed} classes · brotli ${(before / 1024).toFixed(2)} KB → ${(after / 1024).toFixed(2)} KB (-${before - after} B)`);
    },
  };
}

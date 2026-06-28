# mortgage-calc — operational notes

Single-page borrowing-power / mortgage calculator. No backend or SPA routing: the
whole app is one self-contained `dist/index.html` (JS + CSS inlined), served by nginx.

## Structure

- Source is split for editing: `src/*.js` ES modules + `src/styles.css`, entry `index.html`.
- `npm run build` inlines everything into `dist/index.html` via `vite-plugin-singlefile`,
  plus custom plugins in `vite.config.js`:
  - `classicBlockingScript` — inlined JS → classic blocking `<script>` at end of
    `<body>`, so first paint shows populated UI (no deferred-module flash).
  - `minClasses` (`vite-plugin-min-classes.mjs`) — renames every CSS class to a short
    token (.a/.b…) consistently across the inlined `<style>`, HTML and JS, in
    **structural positions only** (`class="…"`, `el.className="…"`, `classList.x("…")`,
    selector strings, CSS selectors). Free text is never touched. A build-time leak
    guard fails the build if a renamed class's original name survives — so write classes
    as COMPLETE string literals (`cond?"a b":"a c"`, not `"a "+(cond?"b":"c")`), and use
    the `SKIP` set for data-driven `${…}` class fragments. ~−0.45 KB brotli.
  - `precompress` — emits `dist/index.html.br` (brotli q11) + `.gz` (gzip -9) alongside.

## Commands

| command | what |
|---|---|
| `npm run dev` | Vite dev server + HMR (split modules) |
| `npm run build` | → `dist/index.html` (+ `.br` / `.gz`) |
| `npm run preview` | serve the built file |
| `npm test` | estimator unit tests (`node --test`, `__tests__/`) |
| `npm run size` | size-budget gate + JS per-module drill-down (build first) |
| `npm run profile:js` | JS per-module breakdown only (= `size --js`, no build) |

## Size budget

Keep brotli-compressed `dist/index.html` under **14 KB** (one TCP initcwnd → single-RTT
cold load). `npm run size` gates on brotli and exits non-zero when over, so it doubles as
a CI smoke test (`--json` for machine output). Currently ~19 KB — over by design until
real content is cut; compression alone won't close it. The appended JS drill-down (also
`npm run profile:js`) attributes minified bytes per `src/*.js` module via esbuild;
`render.js` is the biggest lever.

## Serving (Docker + nginx)

Multi-stage `Dockerfile`: `build` (node) bundles + precompresses; `brotli` compiles
`ngx_brotli` as a dynamic module against the runtime's exact nginx version (own stage so
the C toolchain never ships — adds only ~125 KB); `runtime` (nginx) copies the `.so` + `dist/`.

- `load_module` is **main-context** — prepended to `nginx.conf`, not in the conf.d template.
- `default.conf.template`: `brotli_static on; gzip_static on;` serve the precompressed
  files directly. Port from `MORTGAGE_CALC_PORT` (default 8080); `/health` returns 200.

Verify brotli after `docker run`:
```
curl -s -D - -o /dev/null -H 'Accept-Encoding: br' http://localhost:PORT/
# expect: Content-Encoding: br
```

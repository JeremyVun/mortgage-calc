# mortgage-calc — operational notes

Single-page borrowing-power / mortgage servicing calculator. No backend, no
state, no SPA routing: the whole app is one self-contained `dist/index.html`
(JS + CSS inlined) served by nginx.

## Source vs build

- **Source** is split for editing sanity: `src/*.js` ES modules + `src/styles.css`,
  entry `index.html`.
- **Build** inlines everything into a single `dist/index.html` via
  `vite-plugin-singlefile`. Two custom Vite plugins (`vite.config.js`):
  - `classicBlockingScript` — moves the inlined module to the end of `<body>` as
    a classic, render-blocking script so the first paint already shows populated
    UI (no flash of empty content from a deferred module script).
  - `precompress` — emits `dist/index.html.br` (brotli q11) and
    `dist/index.html.gz` (gzip -9) next to the file, for static serving.

## Commands

| command | what |
|---|---|
| `npm run dev` | Vite dev server + HMR (serves the split modules) |
| `npm run build` | → `dist/index.html` (+ `.br` / `.gz`) |
| `npm run preview` | serve the built file to sanity-check it |
| `npm run size` | one-packet size budget smoke test (alias: `npm test`) |
| `npm run profile:js` | per-source-module breakdown of the minified JS |

## One-packet size budget (the smoke test)

Goal: keep the **compressed** page under the TCP initial congestion window
(~14 KB / 10 segments, RFC 6928) so the whole document arrives in a single round
trip on a cold connection — no TCP slow-start second RTT.

`scripts/size-budget.mjs` (`npm run size`) measures the built `dist/index.html`,
broken into CSS / JS / HTML, under both gzip and brotli. It **gates on brotli**
(the served encoding) against a 14 KB budget and **exits non-zero when over**, so
it doubles as a CI smoke test. `--json` for machine output. Dependency-free —
gzip/brotli come from Node's built-in `zlib`. Run `npm run build` first (it reads
`dist/`).

> Status as of this writing: ~20.5 KB brotli — OVER the 14 KB budget. JS is ~56%
> of the compressed weight (no single fat data table; it's spread across logic),
> CSS ~25%, HTML ~21%. Reaching one packet needs ~6.5 KB of real content cut —
> compression alone won't do it.

To go a level deeper into the JS, `scripts/js-profile.mjs` (`npm run profile:js`)
attributes the **minified** bytes back to each `src/*.js` module via esbuild's
metafile (`bytesInOutput`). It bundles `src/main.js` in-memory with esbuild (a
Vite dependency, so no new install) as a proxy for the shipped Rollup+esbuild
bundle — the total lands within a few hundred bytes of the real one. `--json`
supported. As of this writing **`render.js` is ~46% of the JS** (~5.1 KB brotli);
events.js ~18%, finance.js ~16%, everything else small — so the JS lever is
`render.js`.

## Serving (Docker + nginx)

`Dockerfile` is multi-stage:
- `build` (node) → bundles + precompresses the assets.
- `brotli` (FROM the same `nginx:1.27-alpine`) → compiles `ngx_brotli` as a
  dynamic module with `--with-compat`. The nginx version is read from the image
  itself (`nginx -v`) so the module can't drift from the binary that loads it.
  Only the `*_static` module is kept (we serve precompressed files, so the
  on-the-fly filter module isn't needed).
- `runtime` (nginx) → copies just the compiled `.so` + the built `dist/`.
  `load_module` is prepended to `nginx.conf` (it's a **main-context** directive —
  it cannot live in the conf.d server template).

`default.conf.template`: `brotli_static on; gzip_static on;` — serves the
precompressed `.br` / `.gz` directly (best ratio, zero request-time CPU). The
listen port comes from `MORTGAGE_CALC_PORT` (default 8080) via nginx's
envsubst-on-templates entrypoint; `/health` is a static 200.

**Why a separate `brotli` stage** (not the runtime stage, not the node stage):
multi-stage discards intermediate stages, so the C toolchain (build-base, cmake,
git, nginx source) never ships — the final image gains only the **125 KB** module
(`20.8 MB` base → `20.9 MB`). Compiling in the runtime stage would bake the
toolchain into shipped layers (+hundreds of MB); the node stage has no nginx to
version-match against, and a separate stage lets BuildKit compile the module and
build the assets in parallel.

Verify brotli end-to-end after `docker run`:
```
curl -s -D - -o /dev/null -H 'Accept-Encoding: br' http://localhost:PORT/
# expect: Content-Encoding: br
```

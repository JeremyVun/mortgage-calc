import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Static single-page app. The SOURCE is split into ES modules + styles.css for
// editing sanity, but the BUILD output is one self-contained dist/index.html with
// the JS and CSS inlined — so the browser makes a single request for the page,
// not an HTML -> JS -> CSS waterfall.
//
//   npm run dev      local dev server with HMR (serves the split modules)
//   npm run build    -> dist/index.html (one inlined file; what nginx ships)
//   npm run preview  serve the built file to sanity-check it
export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    // viteSingleFile sets assetsInlineLimit/inlineDynamicImports; nothing else needed.
  },
});

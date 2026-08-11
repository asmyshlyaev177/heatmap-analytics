import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// The dashboard is an ordinary HTML page, so it is built by an ordinary web
// build: Vite resolves the <link> and <script> in src/dashboard.html, Tailwind
// compiles the utilities those files actually use, and vite-plugin-singlefile
// folds the results back into the document.
//
// One document is the point. The Worker serves it from a single text import
// (src/generated/dashboard.txt, written by scripts/build.mjs), which means no
// second route to keep in step and no asset that can 404 out from under the
// page after a redeploy.
//
// The tracker and the viewer stay on esbuild: they are not pages, they are two
// IIFE bundles inlined into the Worker, and their build is already a one-liner
// per bundle in scripts/build.mjs.
// fileURLToPath, not URL.pathname: a URL path is percent-encoded, so a clone
// into a directory with a space in it would hand Vite "…/hma%20space/src" and
// fail to resolve the entry — and `wrangler deploy` runs this same script.
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: here("src/"),
  publicDir: false,
  plugins: [tailwindcss(), viteSingleFile()],
  esbuild: { jsx: "automatic", jsxImportSource: "preact" },
  build: {
    outDir: here("dist/dashboard/"),
    emptyOutDir: true,
    target: "es2020",
    rollupOptions: { input: here("src/dashboard.html") },
  },
  logLevel: "warn",
});

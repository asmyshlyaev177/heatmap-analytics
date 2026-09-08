import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// An ordinary web build for an ordinary page: Vite resolves the <link> and
// <script> in dashboard.html, Tailwind compiles the utilities they use, and
// vite-plugin-singlefile folds the result back into the document. One document
// is the point — the Worker serves it from a single text import, so there is no
// second route to keep in step and no asset that can 404 after a redeploy.
//
// The tracker and viewer stay on esbuild: not pages, two IIFE bundles.
//
// fileURLToPath, not URL.pathname: a percent-encoded path would hand Vite
// "…/hma%20space/src" from a clone in a directory with a space in it.
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: here("src/dashboard/"),
  publicDir: false,
  plugins: [tailwindcss(), viteSingleFile()],
  esbuild: { jsx: "automatic", jsxImportSource: "preact" },
  build: {
    outDir: here("dist/dashboard/"),
    emptyOutDir: true,
    target: "es2020",
    rollupOptions: { input: here("src/dashboard/dashboard.html") },
  },
  logLevel: "warn",
});

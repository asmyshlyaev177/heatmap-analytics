import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { build as viteBuild } from "vite";

// Where the tracker sends beacons, baked into the bundle so an embedding page
// needs nothing but the <script> tag. HM_ENDPOINT overrides it at build time:
// the e2e build sets it empty, which leaves the tracker inert unless a page
// passes data-endpoint — so a test can never post to the live collector.
const endpoint = process.env.HM_ENDPOINT ?? "https://heatmap-analytics.asmyshlyaev177.workers.dev";

mkdirSync("src/generated", { recursive: true });
mkdirSync("dist", { recursive: true });

for (const name of ["tracker", "viewer"]) {
  await build({
    entryPoints: [`src/${name}/index.ts`],
    bundle: true,
    minify: true,
    format: "iife",
    target: "es2020",
    define: { __HM_ENDPOINT__: JSON.stringify(endpoint) },
    outfile: `dist/${name}.js`,
  });
  copyFileSync(`dist/${name}.js`, `src/generated/${name}.txt`);
  const out = readFileSync(`dist/${name}.js`);
  console.log(`${name}.js  ${out.length} B  (gzip ${gzipSync(out).length} B)`);
}

// The dashboard is a page, so Vite builds it and vite-plugin-singlefile folds
// script and styles into one document (see vite.config.ts). One file to serve,
// and the e2e server serves the very same one the Worker embeds. It talks to
// the Worker over relative URLs, so it never reads __HM_ENDPOINT__.
{
  await viteBuild();
  const page = readFileSync("dist/dashboard/dashboard.html");
  copyFileSync("dist/dashboard/dashboard.html", "src/generated/dashboard.txt");
  console.log(`dashboard.html  ${page.length} B  (gzip ${gzipSync(page).length} B)`);
}

// Printed because a bundle built with the wrong endpoint looks identical.
console.log(`collector:  ${endpoint || "(none — data-endpoint required)"}`);

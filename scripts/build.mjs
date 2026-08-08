import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

// Where the tracker sends beacons, baked into the bundle so an embedding page
// needs nothing but the <script> tag. HM_ENDPOINT overrides it at build time:
// the e2e build sets it empty, which leaves the tracker inert unless a page
// passes data-endpoint — so a test can never post to the live collector.
const endpoint = process.env.HM_ENDPOINT ?? "https://heatmap-analytics.asmyshlyaev177.workers.dev";

mkdirSync("src/generated", { recursive: true });
mkdirSync("dist", { recursive: true });

for (const name of ["tracker", "viewer"]) {
  await build({
    entryPoints: [`src/${name}.ts`],
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

// Printed because a bundle built with the wrong endpoint looks identical.
console.log(`collector:  ${endpoint || "(none — data-endpoint required)"}`);

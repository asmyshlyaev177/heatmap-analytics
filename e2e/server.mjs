// Two servers for the e2e suite:
//   PAGES_PORT     serves e2e/fixtures/*            (the "site")
//   COLLECTOR_PORT serves dist/{tracker,viewer}.js  (the "worker")
//                  + POST /collect recording beacons in memory
//                  + GET  /__beacons, POST /__reset for assertions
//
// Separate origins on purpose: that's how the real setup runs, so the specs
// exercise the cross-origin text/plain beacon path (no CORS preflight).
//
// Every collector route may be prefixed with /r/<run-id>, which selects a
// separate beacon bucket. Playwright's context teardown fires pagehide ->
// flush -> sendBeacon, and that request is fire-and-forget: it can land after
// the next test started. Bucketing per test is what keeps such a late beacon
// out of the next test's counts — clearing one shared array cannot.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAGES_PORT = Number(process.env.PAGES_PORT ?? 4399);
const COLLECTOR_PORT = Number(process.env.COLLECTOR_PORT ?? 4400);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

async function sendFile(res, path, extraHeaders = {}) {
  try {
    const body = await readFile(path);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(path)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
      ...extraHeaders,
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }
}

// ---- pages server ----
createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PAGES_PORT}`);
  let pathname = normalize(url.pathname);
  if (pathname === "/" ) pathname = "/index.html";
  // unknown paths (e.g. the soft-nav /virtual URL) fall back to the landing
  // page, mirroring an SPA server
  const name = pathname.replace(/^\/+/, "");
  const candidate = join(ROOT, "e2e", "fixtures", name);
  if (!candidate.startsWith(join(ROOT, "e2e", "fixtures"))) {
    res.writeHead(403).end("forbidden");
    return;
  }
  if (!extname(candidate)) {
    await sendFile(res, join(ROOT, "e2e", "fixtures", "index.html"));
    return;
  }
  await sendFile(res, candidate);
}).listen(PAGES_PORT, () => console.log(`pages     http://localhost:${PAGES_PORT}`));

// ---- collector server ----
const DEFAULT_RUN = "_";
const MAX_RUNS = 64;
/** run id -> recorded beacons */
const runs = new Map();

const bucket = (run) => {
  let b = runs.get(run);
  if (!b) {
    b = [];
    // Map keeps insertion order, so the first key is the oldest run.
    if (runs.size >= MAX_RUNS) runs.delete(runs.keys().next().value);
    runs.set(run, b);
  }
  return b;
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${COLLECTOR_PORT}`);
  const scoped = /^\/r\/([^/]+)(\/.*)$/.exec(normalize(url.pathname));
  const run = scoped ? decodeURIComponent(scoped[1]) : DEFAULT_RUN;
  const pathname = scoped ? scoped[2] : url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS).end();
    return;
  }

  if (req.method === "POST" && pathname === "/collect") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* keep raw for assertions */
    }
    bucket(run).push({
      run,
      raw,
      body: parsed,
      contentType: req.headers["content-type"] ?? null,
      origin: req.headers.origin ?? null,
      at: Date.now(),
    });
    res.writeHead(204, CORS).end();
    return;
  }

  if (pathname === "/__beacons") {
    res.writeHead(200, { "Content-Type": "application/json", ...CORS });
    res.end(JSON.stringify(runs.get(run) ?? []));
    return;
  }

  if (pathname === "/__reset") {
    runs.set(run, []);
    res.writeHead(204, CORS).end();
    return;
  }

  if (pathname === "/tracker.js" || pathname === "/viewer.js") {
    await sendFile(res, join(ROOT, "dist", pathname.slice(1)), CORS);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain", ...CORS }).end("not found");
}).listen(COLLECTOR_PORT, () => console.log(`collector http://localhost:${COLLECTOR_PORT}`));

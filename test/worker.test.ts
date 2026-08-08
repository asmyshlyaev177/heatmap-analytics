import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { ev, makeEnv, pageview } from "./helpers/fake-d1.ts";
import type { TestEnv } from "./helpers/fake-d1.ts";

// worker.ts is written for esbuild/wrangler resolution: the two bundles arrive
// as *.txt text imports and its own modules carry no extension. Node can do
// neither, so both are mapped here — the .txt stubs resolve to their basename,
// which is what the wiring assertions below match on.
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.endsWith(".txt")) return { url: `hma-text:${spec}`, shortCircuit: true };
    if (/^\.{1,2}\//.test(spec) && !/\.[a-z]+$/.test(spec)) return next(`${spec}.ts`, ctx);
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url.startsWith("hma-text:")) {
      const source = `export default ${JSON.stringify(url.slice(url.lastIndexOf("/") + 1))};`;
      return { format: "module", source, shortCircuit: true };
    }
    return next(url, ctx);
  },
});

const mod = await import("../src/worker.ts");
const worker = mod.makeWorker("TRACKER_BUNDLE", "VIEWER_BUNDLE");

const SOURCE = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
const TOKEN = "test-token";
const DAY = 86_400_000;

// name + the query params that endpoint needs to answer 200
const ROUTES = [
  { name: "heatmap", q: "site=testsite&path=%2F" },
  { name: "elements", q: "site=testsite&path=%2F" },
  { name: "sessions", q: "site=testsite&path=%2F" },
  { name: "journey", q: "site=testsite&sid=s1" },
  { name: "replay", q: "pv=pv-1" },
];

const call = (
  env: TestEnv,
  path: string,
  init: RequestInit = {},
  w: { fetch(req: Request, env: never): Promise<Response> } = worker,
) => w.fetch(new Request(`https://collector.test${path}`, init), env as never);

const send = (env: TestEnv, body: Record<string, unknown>) =>
  call(env, "/collect", {
    method: "POST",
    headers: { "Content-Type": "text/plain", "CF-Connecting-IP": "203.0.113.7" },
    body: JSON.stringify(body),
  });

const cors = (res: Response) => ({
  origin: res.headers.get("Access-Control-Allow-Origin"),
  methods: res.headers.get("Access-Control-Allow-Methods"),
  headers: res.headers.get("Access-Control-Allow-Headers"),
});

const CORS_ON = { origin: "*", methods: "GET, POST, OPTIONS", headers: "Content-Type" };

// A new /api/ endpoint must be listed in ROUTES (so the gate loop covers it)
// and must be routed below the authorized() check — moving one above it would
// otherwise leave every test green.
test("every /api/ route sits below the token gate and is covered here", () => {
  const gate = SOURCE.indexOf("authorized(url, env)");
  assert.ok(gate > 0, "token gate not found in worker.ts");
  const found = [...SOURCE.matchAll(/"\/api\/([a-z-]+)"/g)];
  assert.deepEqual(
    found.map((m) => m[1]).sort(),
    ROUTES.map((r) => r.name).sort(),
  );
  for (const m of found)
    assert.ok((m.index as number) > gate, `/api/${m[1]} is routed before the token gate`);
});

for (const { name, q } of ROUTES) {
  test(`/api/${name} requires the viewer token`, async () => {
    const env = makeEnv();
    await send(env, pageview({ ev: [ev("c", 100)] }));

    for (const [label, path, e] of [
      ["no token", `/api/${name}?${q}`, env],
      ["wrong token", `/api/${name}?${q}&t=nope`, env],
      ["empty token", `/api/${name}?${q}&t=`, env],
      ["VIEWER_TOKEN unset", `/api/${name}?${q}&t=${TOKEN}`, { ...env, VIEWER_TOKEN: undefined }],
    ] as [string, string, TestEnv][]) {
      const res = await call(e, path);
      assert.equal(res.status, 401, `${label} should be rejected`);
      assert.deepEqual(await res.json(), { error: "unauthorized" }, label);
      assert.deepEqual(cors(res), CORS_ON, label);
    }

    const ok = await call(env, `/api/${name}?${q}&t=${TOKEN}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("Content-Type"), "application/json");
    assert.deepEqual(cors(ok), CORS_ON);
    env.DB.close();
  });
}

test("an unknown /api path is 404 with a token and 401 without one", async () => {
  const env = makeEnv();
  const un = await call(env, "/api/x");
  assert.equal(un.status, 401);
  const missing = await call(env, `/api/x?t=${TOKEN}`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "not found" });
  env.DB.close();
});

test("POST /collect ingests without a token", async () => {
  const env = makeEnv();
  const res = await send(env, pageview({ ev: [ev("c", 100), ev("m", 200)] }));
  assert.equal(res.status, 204);
  assert.deepEqual(cors(res), CORS_ON);
  assert.equal(env.DB.count("pageviews"), 1);
  assert.equal(env.DB.count("events"), 2);
  env.DB.close();
});

test("GET /collect is not ingest", async () => {
  const env = makeEnv();
  const res = await call(env, "/collect");
  assert.notEqual(res.status, 204);
  assert.match(res.headers.get("Content-Type") ?? "", /text\/plain/);
  assert.equal(env.DB.count("pageviews"), 0);
  env.DB.close();
});

test("methods other than GET/POST/OPTIONS are 405", async () => {
  const env = makeEnv();
  for (const method of ["PUT", "DELETE", "PATCH"]) {
    const res = await call(env, "/collect", { method });
    assert.equal(res.status, 405, method);
    assert.deepEqual(await res.json(), { error: "method" });
  }
  env.DB.close();
});

test("OPTIONS preflight is 204 with the CORS headers, before any auth", async () => {
  const env = makeEnv();
  for (const path of ["/collect", "/api/heatmap"]) {
    const res = await call(env, path, { method: "OPTIONS" });
    assert.equal(res.status, 204, path);
    assert.deepEqual(cors(res), CORS_ON, path);
    assert.equal(await res.text(), "");
  }
  env.DB.close();
});

test("/tracker.js is cacheable, /viewer.js never is", async () => {
  const env = makeEnv();
  const t = await call(env, "/tracker.js");
  assert.equal(t.status, 200);
  assert.equal(t.headers.get("Content-Type"), "application/javascript; charset=utf-8");
  assert.equal(t.headers.get("Cache-Control"), "public, max-age=300");
  assert.equal(await t.text(), "TRACKER_BUNDLE");

  const v = await call(env, "/viewer.js");
  assert.equal(v.status, 200);
  assert.equal(v.headers.get("Content-Type"), "application/javascript; charset=utf-8");
  assert.equal(v.headers.get("Cache-Control"), "no-cache");
  assert.doesNotMatch(v.headers.get("Cache-Control") ?? "", /max-age=[1-9]/);
  assert.equal(await v.text(), "VIEWER_BUNDLE");
  env.DB.close();
});

test("the default export serves each bundle from its own asset", async () => {
  const env = makeEnv();
  assert.equal(await (await call(env, "/tracker.js", {}, mod.default)).text(), "tracker.txt");
  assert.equal(await (await call(env, "/viewer.js", {}, mod.default)).text(), "viewer.txt");
  env.DB.close();
});

test("the root path is plain-text help", async () => {
  const env = makeEnv();
  const res = await call(env, "/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type") ?? "", /text\/plain/);
  const body = await res.text();
  for (const frag of ["POST /collect", "GET  /tracker.js", "GET  /viewer.js", "GET  /api/*"])
    assert.ok(body.includes(frag), frag);
  env.DB.close();
});

test("scheduled() purges pageviews and events past retention", async () => {
  const env = makeEnv();
  const now = Date.now();
  await send(env, pageview({ pv: "old", sa: now - 200 * DAY, ev: [ev("c", 1)] }));
  await send(env, pageview({ pv: "fresh", sa: now - DAY, ev: [ev("c", 2)] }));
  assert.equal(env.DB.count("pageviews"), 2);

  await worker.scheduled({}, env as never);

  assert.deepEqual(
    env.DB.rows<{ id: string }>(`SELECT id FROM pageviews ORDER BY id`).map((r) => r.id),
    ["fresh"],
  );
  assert.deepEqual(
    env.DB.rows<{ pv: string }>(`SELECT DISTINCT pv FROM events`).map((r) => r.pv),
    ["fresh"],
  );
  env.DB.close();
});

test("a failing DB gives 500 without leaking the error to the caller", async () => {
  const env = makeEnv();
  const secret = "D1_ERROR: no such column: pageviews.max_scroll";
  const broken = {
    ...env,
    DB: {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: () => Promise.reject(new Error(secret)),
    },
  } as unknown as TestEnv;

  const logged: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  let res: Response;
  try {
    res = await send(broken, pageview({ ev: [ev("c", 100)] }));
  } finally {
    console.error = original;
  }

  assert.equal(res.status, 500);
  const body = await res.text();
  assert.equal(body, JSON.stringify({ error: "server error" }));
  assert.ok(!body.includes("D1_ERROR"), "response leaks the internal error");
  assert.ok(!body.includes("max_scroll"), "response leaks schema detail");
  assert.deepEqual(cors(res), CORS_ON);
  assert.ok(
    logged.some((args) => JSON.stringify(String((args as unknown[])[1])).includes("D1_ERROR")),
    "the detail must still reach the server log",
  );
  env.DB.close();
});

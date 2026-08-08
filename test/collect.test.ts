import assert from "node:assert/strict";
import { test } from "node:test";
import { collect } from "../src/api.ts";
import { D1_MAX_PARAMS, SID, apiUrl, beacon, ev, makeEnv, pageview } from "./helpers/fake-d1.ts";

interface EvRow {
  pv: string;
  seq: number;
  k: string;
  sel: string | null;
  rx: number | null;
  ry: number | null;
  x: number | null;
  y: number | null;
  t: number;
}

interface PvRow {
  id: string;
  session_id: string;
  site: string;
  path: string;
  vw: number;
  vh: number;
  started_at: number;
  duration_ms: number;
  max_scroll: number;
}

const EVENTS_SQL = "INSERT OR IGNORE INTO events";
const PV_SQL = "INSERT INTO pageviews";

// Wraps the fake DB to record every prepare/bind so the tests can assert how
// collect() chunks its statements, not just what ends up in the tables.
function spyEnv(over: Record<string, unknown> = {}) {
  const base = makeEnv(over as never);
  const calls: { sql: string; params: unknown[] }[] = [];
  const DB = {
    prepare(sql: string) {
      const st = base.DB.prepare(sql);
      return {
        bind: (...v: unknown[]) => {
          calls.push({ sql, params: v });
          return st.bind(...v);
        },
      };
    },
    batch: (stmts: unknown[]) => base.DB.batch(stmts as never),
  };
  return { env: { ...base, DB } as never, db: base.DB, calls };
}

const pvRow = (db: { rows: <T>(sql: string, ...p: unknown[]) => T[] }, id = "pv-1") =>
  db.rows<PvRow>(`SELECT * FROM pageviews WHERE id = ?`, id)[0];

const evRows = (db: { rows: <T>(sql: string, ...p: unknown[]) => T[] }, pv = "pv-1") =>
  db.rows<EvRow>(`SELECT * FROM events WHERE pv = ? ORDER BY seq`, pv);

test("happy path: 204 with no content, CORS, and every column persisted", async () => {
  const env = makeEnv();
  const res = await collect(
    beacon(
      pageview({
        pv: "pv-1",
        path: "/pricing",
        vw: 1280,
        vh: 720,
        sa: 1_700_000_000_000,
        d: 4321,
        msc: 63,
        ev: [ev("c", 120, { s: 0 }), ev("m", 240, { s: 1 }), ev("s", 300, { s: 2, y: 880 })],
      }),
    ),
    env as never,
  );

  assert.equal(res.status, 204);
  assert.equal(await res.text(), "");
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");

  const pv = pvRow(env.DB);
  assert.equal(pv.id, "pv-1");
  assert.equal(pv.site, "testsite");
  assert.equal(pv.path, "/pricing");
  assert.equal(pv.vw, 1280);
  assert.equal(pv.vh, 720);
  assert.equal(pv.started_at, 1_700_000_000_000);
  assert.equal(pv.duration_ms, 4321);
  assert.equal(pv.max_scroll, 63);

  const rows = evRows(env.DB);
  assert.deepEqual(
    rows.map((r) => [r.seq, r.k, r.sel, r.rx, r.ry, r.x, r.y, r.t]),
    [
      [0, "c", "#target", 0.5, 0.5, 100, 200, 120],
      [1, "m", "#target", 0.5, 0.5, 100, 200, 240],
      [2, "s", null, null, null, null, 880, 300],
    ],
  );
  env.DB.close();
});

test("session_id is the client's own id and no raw IP/UA is stored anywhere", async () => {
  const env = makeEnv();
  const ip = "198.51.100.23";
  const ua = "Mozilla/5.0 (SecretDevice; rv:1.0)";
  await collect(beacon(pageview({ ev: [ev("c", 10)] }), { ip, ua }), env as never);

  const pv = pvRow(env.DB);
  assert.equal(pv.session_id, SID);

  const dump = JSON.stringify([
    env.DB.rows("SELECT * FROM pageviews"),
    env.DB.rows("SELECT * FROM events"),
  ]);
  assert.equal(dump.includes(ip), false);
  assert.equal(dump.includes("SecretDevice"), false);
  env.DB.close();
});

test("invalid JSON is rejected with 400 and touches no table", async () => {
  const env = makeEnv();
  const req = new Request("https://collector.test/collect", { method: "POST", body: "{not json" });
  const res = await collect(req, env as never);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "bad json" });
  assert.equal(env.DB.count("pageviews"), 0);
  env.DB.close();
});

test("missing or wrong-typed site/pv/path/ev are rejected with 400", async () => {
  const bad: Record<string, unknown>[] = [
    { pv: "pv-1", path: "/", ev: [] },
    { site: "testsite", path: "/", ev: [] },
    { site: "testsite", pv: "pv-1", ev: [] },
    { site: "testsite", pv: "pv-1", path: "/" },
    { site: 42, pv: "pv-1", path: "/", ev: [] },
    { site: "testsite", pv: 1, path: "/", ev: [] },
    { site: "testsite", pv: "pv-1", path: null, ev: [] },
    { site: "testsite", pv: "pv-1", path: "/", ev: {} },
    { site: "testsite", pv: "pv-1", path: "/", ev: "c" },
  ];
  for (const body of bad) {
    const env = makeEnv();
    const res = await collect(beacon(body), env as never);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.deepEqual(await res.json(), { error: "bad payload" });
    assert.equal(env.DB.count("pageviews"), 0);
    env.DB.close();
  }
});

test("a JSON array body is rejected even though JSON.parse succeeds", async () => {
  const env = makeEnv();
  const req = new Request("https://collector.test/collect", { method: "POST", body: "[1,2,3]" });
  const res = await collect(req, env as never);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "bad payload" });
  env.DB.close();
});

test("body over 250_000 chars is rejected with 413 before parsing", async () => {
  const env = makeEnv();
  const res = await collect(
    beacon(pageview({ path: "/" + "x".repeat(250_000) })),
    env as never,
  );
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: "too large" });
  assert.equal(env.DB.count("pageviews"), 0);

  // the size check runs before JSON.parse: oversized garbage is 413, not 400
  const garbage = new Request("https://collector.test/collect", {
    method: "POST",
    body: "{".repeat(250_001),
  });
  assert.equal((await collect(garbage, env as never)).status, 413);
  env.DB.close();
});

test("a body of exactly 250_000 chars is still accepted", async () => {
  const env = makeEnv();
  const base = JSON.stringify(pageview({ pad: "" })).length;
  const body = pageview({ pad: "a".repeat(250_000 - base) });
  assert.equal(JSON.stringify(body).length, 250_000);
  const res = await collect(beacon(body), env as never);
  assert.equal(res.status, 204);
  assert.equal(env.DB.count("pageviews"), 1);
  env.DB.close();
});

test("ALLOWED_SITES: listed site passes, unknown site is 403 with nothing written", async () => {
  const ok = makeEnv({ ALLOWED_SITES: "testsite,other.example" });
  assert.equal((await collect(beacon(pageview()), ok as never)).status, 204);
  assert.equal(ok.DB.count("pageviews"), 1);
  ok.DB.close();

  const nope = makeEnv({ ALLOWED_SITES: "other.example" });
  const res = await collect(
    beacon(pageview({ site: "evil.example", ev: [ev("c", 1)] })),
    nope as never,
  );
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "unknown site" });
  assert.equal(nope.DB.count("pageviews"), 0);
  assert.equal(nope.DB.count("events"), 0);
  nope.DB.close();
});

test("ALLOWED_SITES entries are trimmed, and an empty/unset value allows any site", async () => {
  const spaced = makeEnv({ ALLOWED_SITES: "  other.example ,  testsite  " });
  assert.equal((await collect(beacon(pageview()), spaced as never)).status, 204);
  spaced.DB.close();

  const unset = makeEnv();
  assert.equal(unset.ALLOWED_SITES, undefined);
  assert.equal((await collect(beacon(pageview({ site: "anything" })), unset as never)).status, 204);
  assert.equal(pvRow(unset.DB).site, "anything");
  unset.DB.close();

  const empty = makeEnv({ ALLOWED_SITES: "" });
  assert.equal((await collect(beacon(pageview({ site: "anything" })), empty as never)).status, 204);
  empty.DB.close();
});

test("re-flush upserts the same pageview row: duration and max_scroll only grow", async () => {
  const env = makeEnv();
  await collect(beacon(pageview({ pv: "pv-1", d: 1000, msc: 30 })), env as never);
  const first = pvRow(env.DB);
  assert.equal(first.duration_ms, 1000);
  assert.equal(first.max_scroll, 30);

  // second flush carrying a different visitor id (localStorage cleared mid-page)
  await collect(
    beacon(pageview({ pv: "pv-1", sid: "visitor-bbbb", d: 9000, msc: 10 })),
    env as never,
  );
  const second = pvRow(env.DB);
  assert.equal(env.DB.count("pageviews"), 1);
  assert.equal(second.duration_ms, 9000);
  assert.equal(second.max_scroll, 30, "max_scroll must never go down");
  assert.equal(second.session_id, first.session_id, "session_id is set on first insert only");

  // prove that id really would have keyed a different session
  await collect(beacon(pageview({ pv: "pv-2", sid: "visitor-bbbb" })), env as never);
  assert.notEqual(pvRow(env.DB, "pv-2").session_id, first.session_id);

  // a growing max_scroll does move
  await collect(beacon(pageview({ pv: "pv-1", d: 12_000, msc: 88 })), env as never);
  const third = pvRow(env.DB);
  assert.equal(third.max_scroll, 88);
  assert.equal(third.duration_ms, 12_000);

  // the real-world case: an early flush (or the keepalive re-send of one)
  // arrives after a later flush. Last-write-wins would rewind the recorded
  // duration and, with it, the episode chaining built on started_at + duration.
  await collect(beacon(pageview({ pv: "pv-1", d: 500, msc: 5 })), env as never);
  const late = pvRow(env.DB);
  assert.equal(late.duration_ms, 12_000, "duration_ms must never go down");
  assert.equal(late.max_scroll, 88, "max_scroll must never go down");
  env.DB.close();
});

test("re-sending an identical batch cannot duplicate events", async () => {
  const env = makeEnv();
  const body = pageview({
    ev: [ev("c", 100, { s: 0 }), ev("m", 200, { s: 1 }), ev("s", 300, { s: 2, y: 400 })],
  });
  await collect(beacon(body), env as never);
  assert.equal(env.DB.count("events"), 3);
  await collect(beacon(body), env as never);
  assert.equal(env.DB.count("events"), 3);
  assert.equal(env.DB.count("pageviews"), 1);
  env.DB.close();
});

test("a re-sent batch keeps the original row for a colliding (pv, seq)", async () => {
  const env = makeEnv();
  await collect(
    beacon(pageview({ ev: [ev("c", 100, { s: 7, el: "#first" })] })),
    env as never,
  );
  await collect(
    beacon(pageview({ ev: [ev("r", 999, { s: 7, el: "#second" })] })),
    env as never,
  );
  const rows = evRows(env.DB);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].k, "c");
  assert.equal(rows[0].sel, "#first");
  assert.equal(rows[0].t, 100);
  env.DB.close();
});

test("duplicate seqs inside one batch collapse to the first occurrence", async () => {
  const env = makeEnv();
  await collect(
    beacon(
      pageview({
        ev: [ev("c", 10, { s: 3, el: "#a" }), ev("c", 20, { s: 3, el: "#b" }), ev("m", 30, { s: 4 })],
      }),
    ),
    env as never,
  );
  const rows = evRows(env.DB);
  assert.deepEqual(
    rows.map((r) => [r.seq, r.sel, r.t]),
    [
      [3, "#a", 10],
      [4, "#target", 30],
    ],
  );
  env.DB.close();
});

test("a later beacon that resends old events plus new ones stores the union", async () => {
  const env = makeEnv();
  const first = [ev("c", 100, { s: 0 }), ev("m", 200, { s: 1 })];
  await collect(beacon(pageview({ ev: first })), env as never);
  await collect(
    beacon(pageview({ ev: [...first, ev("r", 300, { s: 2 }), ev("s", 400, { s: 3, y: 12 })] })),
    env as never,
  );
  assert.deepEqual(
    evRows(env.DB).map((r) => [r.seq, r.k]),
    [
      [0, "c"],
      [1, "m"],
      [2, "r"],
      [3, "s"],
    ],
  );
  env.DB.close();
});

test("only c/m/s/r kinds survive; junk kinds and non-numeric t are dropped", async () => {
  const env = makeEnv();
  await collect(
    beacon(
      pageview({
        ev: [
          ev("c", 10, { s: 0 }),
          ev("m", 20, { s: 1 }),
          ev("s", 30, { s: 2, y: 5 }),
          ev("r", 40, { s: 3 }),
          { s: 4, k: "x", t: 50 },
          { s: 5, k: "click", t: 60 },
          { s: 6, k: "C", t: 70 },
          { s: 7, k: "", t: 80 },
          { s: 8, t: 90 },
          { s: 9, k: "c" },
          { s: 10, k: "c", t: "abc" },
          { s: 11, k: "c", t: {} },
          { s: 12, k: "c", t: [1, 2] },
          null,
          0,
          "c",
          [],
        ],
      }),
    ),
    env as never,
  );
  assert.deepEqual(
    evRows(env.DB).map((r) => [r.seq, r.k]),
    [
      [0, "c"],
      [1, "m"],
      [2, "s"],
      [3, "r"],
    ],
  );
  env.DB.close();
});

test("numeric-string t survives (Number() coercion) and is stored as an integer", async () => {
  const env = makeEnv();
  await collect(
    beacon(pageview({ ev: [{ s: 0, k: "c", t: "1500", el: "#a", rx: 0.25, ry: 0.75, x: 3, y: 4 }] })),
    env as never,
  );
  assert.equal(evRows(env.DB)[0].t, 1500);
  env.DB.close();
});

test("at most 1000 events are stored per beacon", async () => {
  const env = makeEnv();
  const ev1005 = Array.from({ length: 1005 }, (_, i) => ev("c", i, { s: i }));
  await collect(beacon(pageview({ ev: ev1005 })), env as never);
  assert.equal(env.DB.count("events"), 1000);
  const [{ lo, hi }] = env.DB.rows<{ lo: number; hi: number }>(
    "SELECT MIN(seq) AS lo, MAX(seq) AS hi FROM events",
  );
  assert.equal(lo, 0);
  assert.equal(hi, 999);
  env.DB.close();
});

test("dropped events do not consume the 1000-event budget", async () => {
  const env = makeEnv();
  const junk = Array.from({ length: 20 }, (_, i) => ({ s: 9000 + i, k: "junk", t: i }));
  const good = Array.from({ length: 1000 }, (_, i) => ev("m", i, { s: i }));
  await collect(beacon(pageview({ ev: [...junk, ...good] })), env as never);
  assert.equal(env.DB.count("events"), 1000);
  assert.equal(env.DB.rows<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE k='m'")[0].n, 1000);
  env.DB.close();
});

test("35 events chunk into 4 statements, none over the D1 param limit", async () => {
  const { env, db, calls } = spyEnv();
  const events = Array.from({ length: 35 }, (_, i) =>
    ev(i % 2 === 0 ? "c" : "m", 1000 + i * 10, { s: i, el: `#el-${i}` }),
  );
  const res = await collect(beacon(pageview({ ev: events })), env);
  assert.equal(res.status, 204);

  for (const c of calls) assert.ok(c.params.length <= D1_MAX_PARAMS, `${c.params.length} params`);
  assert.deepEqual(
    calls.filter((c) => c.sql.startsWith(EVENTS_SQL)).map((c) => c.params.length),
    [90, 90, 90, 45],
  );
  assert.equal(calls.filter((c) => c.sql.includes(PV_SQL)).length, 1);

  const rows = evRows(db);
  assert.equal(rows.length, 35);
  assert.deepEqual(
    rows.map((r) => [r.seq, r.k, r.sel, r.t]),
    events.map((e, i) => [i, i % 2 === 0 ? "c" : "m", `#el-${i}`, 1000 + i * 10]),
  );
  db.close();
});

test("chunk boundaries: 10 events = 1 statement, 11 = 2", async () => {
  for (const [n, sizes] of [
    [1, [9]],
    [10, [90]],
    [11, [90, 9]],
    [20, [90, 90]],
    [21, [90, 90, 9]],
  ] as [number, number[]][]) {
    const { env, db, calls } = spyEnv();
    await collect(
      beacon(pageview({ ev: Array.from({ length: n }, (_, i) => ev("c", i, { s: i })) })),
      env,
    );
    assert.deepEqual(
      calls.filter((c) => c.sql.startsWith(EVENTS_SQL)).map((c) => c.params.length),
      sizes,
      `n=${n}`,
    );
    assert.equal(db.count("events"), n);
    db.close();
  }
});

test("an empty ev array issues no event statement at all", async () => {
  const { env, db, calls } = spyEnv();
  const res = await collect(beacon(pageview({ ev: [] })), env);
  assert.equal(res.status, 204);
  assert.equal(calls.filter((c) => c.sql.startsWith(EVENTS_SQL)).length, 0);
  assert.equal(db.count("pageviews"), 1);
  assert.equal(db.count("events"), 0);
  db.close();
});

test("1000 events stay within the param limit across all 100 statements", async () => {
  const { env, db, calls } = spyEnv();
  await collect(
    beacon(pageview({ ev: Array.from({ length: 1000 }, (_, i) => ev("c", i, { s: i })) })),
    env,
  );
  const evCalls = calls.filter((c) => c.sql.startsWith(EVENTS_SQL));
  assert.equal(evCalls.length, 100);
  assert.equal(Math.max(...evCalls.map((c) => c.params.length)), 90);
  assert.equal(db.count("events"), 1000);
  db.close();
});

test("pageview numbers are rounded, and max_scroll is clamped to 0..100", async () => {
  const cases: [unknown, number][] = [
    [150, 100],
    [100.4, 100],
    [-5, 0],
    [42.6, 43],
    [42.4, 42],
    ["77", 77],
    ["nope", 0],
    [undefined, 0],
  ];
  for (const [msc, want] of cases) {
    const env = makeEnv();
    await collect(beacon(pageview({ msc })), env as never);
    assert.equal(pvRow(env.DB).max_scroll, want, `msc=${String(msc)}`);
    env.DB.close();
  }

  const env = makeEnv();
  await collect(
    beacon(pageview({ vw: 1439.6, vh: "900", sa: 1_700_000_000_000.4, d: "abc" })),
    env as never,
  );
  const pv = pvRow(env.DB);
  assert.equal(pv.vw, 1440);
  assert.equal(pv.vh, 900);
  assert.equal(pv.started_at, 1_700_000_000_000);
  assert.equal(pv.duration_ms, 0);
  env.DB.close();
});

test("pv/site truncate at 64 chars, path at 256, and events reuse the truncated pv", async () => {
  const env = makeEnv();
  const longPv = "p".repeat(70);
  const longSite = "s".repeat(70);
  const longPath = "/" + "d".repeat(400);
  await collect(
    beacon(
      pageview({ pv: longPv, site: longSite, path: longPath, ev: [ev("c", 10, { s: 0 })] }),
    ),
    env as never,
  );
  const pv = pvRow(env.DB, longPv.slice(0, 64));
  assert.equal(pv.id, "p".repeat(64));
  assert.equal(pv.site, "s".repeat(64));
  assert.equal(pv.path, longPath.slice(0, 256));
  assert.equal(pv.path.length, 256);
  // events.pv must match pageviews.id or every read-side join breaks
  const rows = evRows(env.DB, pv.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pv, pv.id);
  env.DB.close();
});

test("event columns: selector truncation, rx/ry clamping, int rounding, NULLs", async () => {
  const env = makeEnv();
  await collect(
    beacon(
      pageview({
        ev: [
          { s: 0, k: "c", el: "#" + "a".repeat(400), rx: 0.5, ry: 0.5, x: 1, y: 2, t: 10 },
          { s: 1, k: "c", el: "#b", rx: 7, ry: -5, x: 1, y: 2, t: 20 },
          { s: 2, k: "c", el: "#c", rx: 0.123456, ry: 0.99999, x: 1, y: 2, t: 30 },
          { s: 3, k: "c", el: "#d", rx: "nope", ry: 0.5, x: 1, y: 2, t: 40 },
          { s: 4, k: "c", el: "", rx: 0.5, ry: 0.5, x: 1, y: 2, t: 50 },
          { s: 5, k: "c", el: "#f", rx: 0.5, ry: 0.5, x: 100.4, y: -1.5, t: 60 },
          { s: 6, k: "c", el: "#g", rx: 0.5, ry: 0.5, x: null, y: null, t: 70 },
          { s: 7, k: "c", el: "#h", rx: 0.5, ry: 0.5, t: 80 },
          { s: 8, k: "c", el: "#i", rx: 0.5, ry: 0.5, x: "12", y: "34", t: 90 },
          { k: "c", el: "#j", rx: 0.5, ry: 0.5, x: 1, y: 2, t: 100 },
        ],
      }),
    ),
    env as never,
  );

  const rows = evRows(env.DB);
  const bySeq = new Map(rows.map((r) => [r.seq, r]));

  assert.equal(bySeq.get(0)!.sel!.length, 300);
  assert.equal(bySeq.get(0)!.sel, ("#" + "a".repeat(400)).slice(0, 300));
  assert.equal(bySeq.get(1)!.rx, 3);
  assert.equal(bySeq.get(1)!.ry, -2);
  assert.equal(bySeq.get(2)!.rx, 0.1235);
  assert.equal(bySeq.get(2)!.ry, 1);
  assert.equal(bySeq.get(3)!.rx, null);
  assert.equal(bySeq.get(3)!.ry, 0.5);
  assert.equal(bySeq.get(4)!.sel, null, "an empty selector is stored as NULL");
  assert.equal(bySeq.get(5)!.x, 100);
  assert.equal(bySeq.get(5)!.y, -1);
  assert.equal(bySeq.get(6)!.x, null);
  assert.equal(bySeq.get(6)!.y, null);
  assert.equal(bySeq.get(7)!.x, null);
  assert.equal(bySeq.get(7)!.y, null);
  assert.equal(bySeq.get(8)!.x, 12);
  assert.equal(bySeq.get(8)!.y, 34);
  // the seq-less event collides with seq 0 and is dropped by OR IGNORE
  assert.equal(rows.length, 9);
  assert.equal(bySeq.get(0)!.t, 10);
  env.DB.close();
});

test("a missing seq coerces to 0", async () => {
  const env = makeEnv();
  await collect(
    beacon(pageview({ ev: [{ k: "c", el: "#a", rx: 0.5, ry: 0.5, x: 1, y: 2, t: 10 }] })),
    env as never,
  );
  const rows = evRows(env.DB);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].seq, 0);
  env.DB.close();
});

test("scroll events store NULL sel/rx/ry/x and keep scrollY in y", async () => {
  const env = makeEnv();
  await collect(
    beacon(pageview({ ev: [ev("s", 250, { s: 0, y: 1234 }), ev("s", 500, { s: 1, y: 0 })] })),
    env as never,
  );
  assert.deepEqual(
    evRows(env.DB).map((r) => [r.k, r.sel, r.rx, r.ry, r.x, r.y, r.t]),
    [
      ["s", null, null, null, null, 1234, 250],
      ["s", null, null, null, null, 0, 500],
    ],
  );
  env.DB.close();
});

test("two beacons for different pv ids of one visitor share a session_id", async () => {
  const env = makeEnv();
  await collect(beacon(pageview({ pv: "pv-a", path: "/a" })), env as never);
  await collect(beacon(pageview({ pv: "pv-b", path: "/b" })), env as never);
  assert.equal(env.DB.count("pageviews"), 2);
  assert.equal(pvRow(env.DB, "pv-a").session_id, pvRow(env.DB, "pv-b").session_id);
  assert.equal(pvRow(env.DB, "pv-a").session_id, SID);
  env.DB.close();
});

test("collect ignores query params and unknown body keys", async () => {
  const env = makeEnv();
  const url = apiUrl("collect", { t: "test-token", site: "spoof" }).toString();
  const req = new Request(url, {
    method: "POST",
    headers: { "CF-Connecting-IP": "203.0.113.7", "User-Agent": "UA" },
    body: JSON.stringify(pageview({ nonsense: { a: 1 }, v: 99, ev: [ev("c", 10, { s: 0 })] })),
  });
  const res = await collect(req, env as never);
  assert.equal(res.status, 204);
  assert.equal(pvRow(env.DB).site, "testsite");
  assert.equal(env.DB.count("events"), 1);
  env.DB.close();
});

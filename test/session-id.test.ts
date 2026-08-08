// The identity model: session_id is an anonymous id the browser mints once and
// keeps in localStorage. The collector treats it as opaque but pins its shape,
// and derives nothing at all from the request — no IP, no User-Agent, no salt.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { collect, sessionId } from "../src/api.ts";
import { SID_KEY, SID_RE } from "../src/sid.ts";
import { SID, beacon, ev, makeEnv, pageview, type TestEnv } from "./helpers/fake-d1.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const IP = "198.51.100.23";
// contains a pure-hex run so "did the raw UA leak into the stored id" can fail
const UA = "Mozilla/5.0 (X11; Linux x86_64) Build/beefcafe";

const sidOf = (env: TestEnv, id = "pv-1") =>
  env.DB.rows<{ session_id: string }>(`SELECT session_id FROM pageviews WHERE id = ?`, id)[0]
    .session_id;

// ---------- sessionId() ----------

test("sessionId() passes a well-formed client id through untouched", () => {
  for (const ok of [
    "visitor-aaaa",
    "0f7c1e64-2b1a-4c3d-9e77-8a1b2c3d4e5f", // crypto.randomUUID()
    "l9k2j1h0-a1b2c3d4", // the tracker's no-randomUUID fallback
    "a".repeat(8),
    "a".repeat(64),
    "_-_-_-_-",
    "A1b2C3d4_-x",
  ]) {
    assert.equal(sessionId(ok), ok, ok);
    assert.match(ok, SID_RE);
  }
});

test("sessionId() replaces a malformed or missing id with a fresh random uuid", () => {
  const bad: unknown[] = [
    undefined,
    null,
    "",
    "short7", // under the 8-char floor
    "a".repeat(65), // over the 64-char ceiling
    "has space",
    "has.dot",
    "semi;colon",
    "quote'x",
    "slash/x",
    "percent%20",
    "unicode-café",
    "new\nline",
    42,
    {},
    [],
    ["visitor-aaaa"],
    true,
  ];
  const minted = bad.map((v) => sessionId(v));
  for (const [i, id] of minted.entries()) {
    assert.match(id, UUID, JSON.stringify(bad[i]));
    assert.match(id, SID_RE, JSON.stringify(bad[i]));
  }
  // a throwaway id per beacon, never one shared bucket every stranger lands in
  assert.equal(new Set(minted).size, minted.length);
});

test("sessionId() derives nothing: one argument in, the same value out", () => {
  assert.equal(sessionId(SID), sessionId(SID));
});

test("the localStorage key is pinned: renaming it orphans every stored id", () => {
  // A rename is not a refactor. Every existing visitor's id lives under this
  // exact key in the host site's origin, so changing it silently resets the
  // whole population to first-time visitors.
  assert.equal(SID_KEY, "hma_sid");
});

test("both ends validate against one shared shape, not two copies of it", async () => {
  // The tracker reads SID_RE out of src/sid.ts too. If it ever inlined its own
  // copy again, an id the tracker forwards could be one the collector refuses —
  // and a refused id becomes a throwaway, so journeys would break in silence.
  const tracker = await readFile(new URL("../src/tracker.ts", import.meta.url), "utf8");
  assert.match(tracker, /SID_RE\.test\(/, "the tracker must use the shared regex");
  assert.ok(
    !/\{8,\s*64\}/.test(tracker),
    "the tracker must not restate the id shape — import it from src/sid.ts",
  );
});

// ---------- through collect() ----------

test("the client id is stored verbatim as session_id", async () => {
  const env = makeEnv();
  const res = await collect(beacon(pageview({ sid: "visitor-zzzz" })), env as never);
  assert.equal(res.status, 204);
  assert.equal(sidOf(env), "visitor-zzzz");
  env.DB.close();
});

test("an id at either length boundary survives the round trip uncut", async () => {
  // nothing downstream truncates session_id the way pv/site/path are truncated,
  // so the 64-char ceiling in SID_RE is the only thing bounding the column
  for (const sid of ["a".repeat(8), "b".repeat(64)]) {
    const env = makeEnv();
    assert.equal((await collect(beacon(pageview({ sid })), env as never)).status, 204);
    assert.equal(sidOf(env), sid);
    assert.equal(sidOf(env).length, sid.length);
    env.DB.close();
  }

  // one char past the ceiling is refused and replaced, never stored truncated
  const over = makeEnv();
  const tooLong = "c".repeat(65);
  await collect(beacon(pageview({ sid: tooLong })), over as never);
  const stored = sidOf(over);
  assert.notEqual(stored, tooLong);
  assert.notEqual(stored, tooLong.slice(0, 64));
  assert.match(stored, UUID);
  over.DB.close();
});

test("collect() links a visitor's pageviews by their id, and splits on a different one", async () => {
  const env = makeEnv();
  const post = (pv: string, over: Record<string, unknown> = {}) =>
    collect(beacon(pageview({ pv, ...over }), { ip: IP, ua: UA }), env as never);

  assert.equal((await post("pv-1")).status, 204);
  assert.equal((await post("pv-2")).status, 204);
  assert.equal((await post("pv-3", { sid: "visitor-bbbb" })).status, 204);
  // sid: undefined drops the key from the JSON body entirely — no id at all
  assert.equal((await post("pv-4", { sid: undefined })).status, 204);

  const rows = env.DB.rows<{ id: string; session_id: string }>(
    "SELECT id, session_id FROM pageviews ORDER BY id",
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    ["pv-1", "pv-2", "pv-3", "pv-4"],
  );
  assert.equal(rows[1].session_id, rows[0].session_id, "same id => one session");
  assert.equal(rows[0].session_id, SID);
  assert.equal(rows[2].session_id, "visitor-bbbb");
  assert.match(rows[3].session_id, UUID);
  assert.equal(new Set(rows.map((r) => r.session_id)).size, 3);
  env.DB.close();
});

test("the same visitor is NOT split by a changing ip or user agent", async () => {
  // the whole point of moving the id client-side: a phone hopping wifi-to-mobile
  // mid-visit used to become two visitors
  const env = makeEnv();
  await collect(beacon(pageview({ pv: "pv-1" }), { ip: IP, ua: UA }), env as never);
  await collect(
    beacon(pageview({ pv: "pv-2" }), { ip: "203.0.113.99", ua: "Mozilla/5.0 (Other)" }),
    env as never,
  );
  assert.equal(sidOf(env, "pv-2"), sidOf(env, "pv-1"));
  env.DB.close();
});

test("two visitors behind one ip and user agent are NOT merged", async () => {
  // the other half: shared NAT + identical browser used to hash to one session
  const env = makeEnv();
  const headers = { ip: IP, ua: UA };
  await collect(beacon(pageview({ pv: "pv-1", sid: "visitor-aaaa" }), headers), env as never);
  await collect(beacon(pageview({ pv: "pv-2", sid: "visitor-bbbb" }), headers), env as never);
  assert.notEqual(sidOf(env, "pv-2"), sidOf(env, "pv-1"));
  env.DB.close();
});

test("session_id is set on first insert only, so a re-flush cannot re-key it", async () => {
  // e.g. the visitor cleared localStorage between two flushes of one pageview
  const env = makeEnv();
  const flush = (sid: string, d: number) =>
    collect(beacon(pageview({ pv: "pv-1", sid, d })), env as never);
  await flush("visitor-aaaa", 1000);
  await flush("visitor-bbbb", 2000);
  assert.equal(sidOf(env), "visitor-aaaa");
  assert.equal(env.DB.count("pageviews"), 1);
  env.DB.close();
});

test("no ip or user agent reaches the database", async () => {
  const env = makeEnv();
  const res = await collect(
    beacon(pageview({ ev: [ev("c", 100), ev("m", 200), ev("s", 300)] }), { ip: IP, ua: UA }),
    env as never,
  );
  assert.equal(res.status, 204);

  const stored = [
    ...env.DB.rows("SELECT * FROM pageviews"),
    ...env.DB.rows("SELECT * FROM events"),
  ];
  assert.equal(stored.length, 4);
  const values = stored.flatMap((r) => Object.values(r).map((v) => String(v)));
  for (const secret of [
    IP,
    "198.51",
    IP.replaceAll(".", ""),
    UA,
    "beefcafe",
    "Mozilla",
    "x86_64",
  ]) {
    for (const v of values) assert.ok(!v.includes(secret), `stored ${v} contains ${secret}`);
  }
  env.DB.close();
});

test("no table has a column for ip, user agent or cookie", () => {
  const env = makeEnv();
  const cols = env.DB.rows<{ tbl: string; col: string }>(
    `SELECT m.name AS tbl, i.name AS col
     FROM sqlite_master m JOIN pragma_table_info(m.name) i
     WHERE m.type = 'table'`,
  );
  assert.ok(cols.length > 0);
  for (const { tbl, col } of cols) {
    const n = col.toLowerCase();
    assert.ok(
      n !== "ip" && n !== "ua" && !/agent|cookie|addr/.test(n),
      `${tbl}.${col} looks like device data`,
    );
  }
  env.DB.close();
});

test("the salts table is gone: no server-side derivation is left to leak", () => {
  const env = makeEnv();
  const tables = env.DB
    .rows<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .map((r) => r.name);
  assert.ok(!tables.includes("salts"), tables.join(","));
  env.DB.close();
});

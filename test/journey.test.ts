// Invariant 5: a session_id outlives any single visit, so "journeys" are
// reconstructed by chaining pageviews whose gaps look like real navigations.
import assert from "node:assert/strict";
import { test } from "node:test";
import { NAV_CHAIN_GAP_MS, apiJourney, apiSessions, episodeAround } from "../src/api.ts";
import { apiUrl, makeEnv, type TestEnv } from "./helpers/fake-d1.ts";

const T = 1_700_000_000_000;

const pv = (id: string, started_at: number, duration_ms = 0) => ({ id, started_at, duration_ms });
const ids = (list: { id: string }[]) => list.map((p) => p.id);

interface PvRow {
  id: string;
  sid?: string;
  site?: string;
  path?: string;
  sa: number;
  d?: number;
  vw?: number;
  vh?: number;
  msc?: number;
}

async function insertPv(env: TestEnv, row: PvRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO pageviews (id, session_id, site, path, vw, vh, started_at, duration_ms, max_scroll)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(
      row.id,
      row.sid ?? "sid-a",
      row.site ?? "testsite",
      row.path ?? "/",
      row.vw ?? 1440,
      row.vh ?? 900,
      row.sa,
      row.d ?? 0,
      row.msc ?? 0,
    )
    .run();
}

async function insertEvents(env: TestEnv, pvId: string, kinds: string[]): Promise<void> {
  let seq = 0;
  for (const k of kinds) {
    await env.DB.prepare(
      `INSERT INTO events (pv, seq, k, sel, rx, ry, x, y, t) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
    )
      .bind(pvId, seq, k, "#target", 0.5, 0.5, 100, 200, seq * 100)
      .run();
    seq++;
  }
}

const sessions = async (env: TestEnv, params: Record<string, string> = {}) => {
  const res = await apiSessions(
    apiUrl("sessions", { site: "testsite", path: "/", ...params }),
    env as never,
  );
  assert.equal(res.status, 200);
  return ((await res.json()) as { sessions: Record<string, unknown>[] }).sessions;
};

const journey = async (env: TestEnv, params: Record<string, string>) => {
  const res = await apiJourney(apiUrl("journey", { site: "testsite", ...params }), env as never);
  assert.equal(res.status, 200);
  return ((await res.json()) as { pageviews: { id: string; path: string; started_at: number }[] })
    .pageviews;
};

// ---------- episodeAround() ----------

test("episodeAround: a lone pageview is its own episode", () => {
  const only = pv("a", T, 5000);
  assert.deepEqual(episodeAround([only], "a"), [only]);
});

test("episodeAround: pageviews chained by real navigation group together", () => {
  // b starts 2s after a's last activity (T + 10s), c 5s after b's (T + 24s)
  const list = [pv("a", T, 10_000), pv("b", T + 12_000, 12_000), pv("c", T + 29_000, 1000)];
  assert.deepEqual(ids(episodeAround(list, "a")), ["a", "b", "c"]);
  assert.deepEqual(ids(episodeAround(list, "b")), ["a", "b", "c"]);
  assert.deepEqual(ids(episodeAround(list, "c")), ["a", "b", "c"]);
});

test("episodeAround: an idle gap over the chain limit splits the journey", () => {
  const list = [
    pv("a", T, 5000),
    pv("b", T + 6000, 1000),
    // 10 minutes of idle after b ends: a separate visit, a separate replay
    pv("c", T + 600_000, 1000),
    pv("d", T + 605_000, 0),
  ];
  assert.deepEqual(ids(episodeAround(list, "a")), ["a", "b"]);
  assert.deepEqual(ids(episodeAround(list, "b")), ["a", "b"]);
  assert.deepEqual(ids(episodeAround(list, "c")), ["c", "d"]);
  assert.deepEqual(ids(episodeAround(list, "d")), ["c", "d"]);
});

test("episodeAround: the chain boundary is exclusive at NAV_CHAIN_GAP_MS", () => {
  assert.equal(NAV_CHAIN_GAP_MS, 30_000);
  const prevEnd = T + 4000; // started_at T, duration 4000
  const exact = [pv("a", T, 4000), pv("b", prevEnd + NAV_CHAIN_GAP_MS, 0)];
  assert.deepEqual(ids(episodeAround(exact, "a")), ["a"]);
  assert.deepEqual(ids(episodeAround(exact, "b")), ["b"]);
  const under = [pv("a", T, 4000), pv("b", prevEnd + NAV_CHAIN_GAP_MS - 1, 0)];
  assert.deepEqual(ids(episodeAround(under, "a")), ["a", "b"]);
});

test("episodeAround: chaining measures from the previous pageview's end, not its start", () => {
  // a was read for 10 minutes; b starts 1s after it ends, so it is the same
  // journey even though the two starts are ~10 minutes apart
  const list = [pv("a", T, 600_000), pv("b", T + 601_000, 0)];
  assert.deepEqual(ids(episodeAround(list, "a")), ["a", "b"]);
  assert.deepEqual(ids(episodeAround(list, "b")), ["a", "b"]);
  // same starts, but a recorded no duration: now the gap is real idle
  const noDuration = [pv("a", T, 0), pv("b", T + 601_000, 0)];
  assert.deepEqual(ids(episodeAround(noDuration, "a")), ["a"]);
});

test("episodeAround: overlapping pageviews (flush after the next nav) chain", () => {
  // duration reported past the next pageview's start => negative gap
  const list = [pv("a", T, 20_000), pv("b", T + 15_000, 1000)];
  assert.deepEqual(ids(episodeAround(list, "b")), ["a", "b"]);
});

test("episodeAround: an unknown pv id returns the input unchanged", () => {
  const list = [pv("a", T, 0), pv("b", T + 900_000, 0)];
  assert.deepEqual(episodeAround(list, "nope"), list);
  assert.deepEqual(episodeAround([], "nope"), []);
});

test("episodeAround: chains across many legs but stops at the first long gap", () => {
  const list = [
    pv("a", T, 1000),
    pv("b", T + 2000, 1000),
    pv("c", T + 4000, 1000),
    pv("d", T + 6000, 1000),
    pv("e", T + 8000, 1000),
    pv("f", T + 120_000, 1000),
  ];
  assert.deepEqual(ids(episodeAround(list, "c")), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(ids(episodeAround(list, "f")), ["f"]);
});

// ---------- apiSessions ----------

test("apiSessions: pages is the row's episode size, not the day's session", async () => {
  const env = makeEnv();
  await insertPv(env, { id: "pv-a", sa: T, d: 10_000 });
  await insertPv(env, { id: "pv-b", sa: T + 12_000, d: 5000 }); // chained to pv-a
  await insertPv(env, { id: "pv-c", sa: T + 3_600_000, d: 1000 }); // an hour later, same visitor
  const rows = await sessions(env);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["pv-c", "pv-b", "pv-a"],
  );
  assert.deepEqual(
    rows.map((r) => r.pages),
    [1, 2, 2],
  );
  assert.deepEqual(new Set(rows.map((r) => r.session_id)), new Set(["sid-a"]));
  env.DB.close();
});

test("apiSessions: an episode spans paths even though rows are filtered by path", async () => {
  const env = makeEnv();
  await insertPv(env, { id: "pv-a", sa: T, d: 4000 });
  await insertPv(env, { id: "pv-b", path: "/pricing", sa: T + 5000, d: 2000 });
  const rows = await sessions(env);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["pv-a"],
  );
  assert.equal(rows[0].pages, 2);
  env.DB.close();
});

test("apiSessions: counts clicks, rage and events separately", async () => {
  const env = makeEnv();
  await insertPv(env, { id: "pv-a", sa: T, d: 1000, vw: 800, vh: 600, msc: 73 });
  await insertEvents(env, "pv-a", ["c", "c", "r", "m", "s"]);
  const [row] = await sessions(env);
  assert.equal(row.clicks, 2);
  assert.equal(row.rage, 1);
  assert.equal(row.events, 5);
  assert.equal(row.vw, 800);
  assert.equal(row.vh, 600);
  assert.equal(row.max_scroll, 73);
  assert.equal(row.started_at, T);
  assert.equal(row.duration_ms, 1000);
  env.DB.close();
});

test("apiSessions: a pageview with no events still reports pages 1", async () => {
  const env = makeEnv();
  await insertPv(env, { id: "pv-a", sa: T, d: 0 });
  const [row] = await sessions(env);
  assert.equal(row.events, 0);
  assert.equal(row.clicks, 0);
  assert.equal(row.rage, 0);
  assert.equal(row.pages, 1);
  env.DB.close();
});

test("apiSessions: pages never drops below 1 when the episode lookup finds nothing", async () => {
  const env = makeEnv();
  await insertPv(env, { id: "pv-a", sid: "", sa: T, d: 0 });
  const [row] = await sessions(env);
  assert.equal(row.session_id, "");
  assert.equal(row.pages, 1);
  env.DB.close();
});

test("apiSessions: an identical session_id on another site does not inflate pages", async () => {
  const env = makeEnv();
  await insertPv(env, { id: "pv-a", sa: T, d: 1000 });
  await insertPv(env, { id: "pv-other", site: "othersite", sa: T + 2000, d: 1000 });
  const [row] = await sessions(env);
  assert.equal(row.id, "pv-a");
  assert.equal(row.pages, 1);
  env.DB.close();
});

// ---------- apiJourney ----------

test("apiJourney with ?pv returns just that episode, in started_at order", async () => {
  const env = makeEnv();
  // inserted out of chronological order on purpose
  await insertPv(env, { id: "pv-b", path: "/pricing", sa: T + 12_000, d: 5000 });
  await insertPv(env, { id: "pv-late", path: "/docs", sa: T + 3_600_000, d: 1000 });
  await insertPv(env, { id: "pv-a", sa: T, d: 10_000 });
  const first = await journey(env, { sid: "sid-a", pv: "pv-a" });
  assert.deepEqual(
    first.map((p) => p.id),
    ["pv-a", "pv-b"],
  );
  assert.deepEqual(
    first.map((p) => p.path),
    ["/", "/pricing"],
  );
  assert.deepEqual(
    first.map((p) => p.started_at),
    [T, T + 12_000],
  );
  const late = await journey(env, { sid: "sid-a", pv: "pv-late" });
  assert.deepEqual(
    late.map((p) => p.id),
    ["pv-late"],
  );
  env.DB.close();
});

test("apiJourney without ?pv returns every pageview of the session", async () => {
  const env = makeEnv();
  await insertPv(env, { id: "pv-a", sa: T, d: 10_000 });
  await insertPv(env, { id: "pv-b", path: "/pricing", sa: T + 12_000, d: 5000 });
  await insertPv(env, { id: "pv-late", path: "/docs", sa: T + 3_600_000, d: 1000 });
  const all = await journey(env, { sid: "sid-a" });
  assert.deepEqual(
    all.map((p) => p.id),
    ["pv-a", "pv-b", "pv-late"],
  );
  env.DB.close();
});

test("apiJourney is scoped by site and session", async () => {
  const env = makeEnv();
  await insertPv(env, { id: "pv-a", sa: T, d: 1000 });
  await insertPv(env, { id: "pv-other-site", site: "othersite", sa: T + 2000, d: 1000 });
  await insertPv(env, { id: "pv-other-sid", sid: "sid-b", sa: T + 2000, d: 1000 });
  assert.deepEqual(
    (await journey(env, { sid: "sid-a" })).map((p) => p.id),
    ["pv-a"],
  );
  assert.deepEqual(
    (await journey(env, { sid: "sid-b" })).map((p) => p.id),
    ["pv-other-sid"],
  );
  assert.deepEqual(await journey(env, { sid: "sid-a", pv: "pv-other-site" }), [
    { id: "pv-a", path: "/", started_at: T, duration_ms: 1000, vw: 1440, vh: 900 },
  ]);
  env.DB.close();
});

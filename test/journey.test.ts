// Invariant 5: a session_id outlives any single visit, so "journeys" are
// reconstructed by chaining pageviews whose gaps look like real navigations.
import assert from "node:assert/strict";
import { test } from "node:test";
import { NAV_CHAIN_GAP_MS, apiJourney, apiSessions, episodeAround } from "../src/api.ts";
import { IDLE_GAP_MS } from "../src/timeline.ts";
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
  am?: number | null;
  vw?: number;
  vh?: number;
  msc?: number;
}

async function insertPv(env: TestEnv, row: PvRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO pageviews (id, session_id, site, path, vw, vh, started_at, duration_ms, active_ms, max_scroll)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
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
      row.am ?? null,
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

/** Events at explicit offsets, inserted in seq order — what active_ms reads. */
async function insertAt(env: TestEnv, pvId: string, ts: number[], k = "m"): Promise<void> {
  let seq = 0;
  for (const t of ts) {
    await env.DB.prepare(
      `INSERT INTO events (pv, seq, k, sel, rx, ry, x, y, t) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
    )
      .bind(pvId, seq++, k, "#target", 0.5, 0.5, 100, 200, t)
      .run();
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

test("apiSessions: legs number over the whole journey, not over the listed rows", async () => {
  const env = makeEnv();
  // a visitor bouncing between "/" and "/pricing": only the "/" rows are
  // listed, and they must keep their place in the five-page visit
  await insertPv(env, { id: "pv-1", sa: T, d: 1000 });
  await insertPv(env, { id: "pv-2", path: "/pricing", sa: T + 2000, d: 1000 });
  await insertPv(env, { id: "pv-3", sa: T + 4000, d: 1000 });
  await insertPv(env, { id: "pv-4", path: "/pricing", sa: T + 6000, d: 1000 });
  await insertPv(env, { id: "pv-5", sa: T + 8000, d: 1000 });

  const rows = await sessions(env);
  assert.deepEqual(
    rows.map((r) => [r.id, r.leg, r.pages]),
    [
      ["pv-5", 5, 5],
      ["pv-3", 3, 5],
      ["pv-1", 1, 5],
    ],
  );
  // one visit throughout, so the grouping half of the chip stays constant
  assert.equal(new Set(rows.map((r) => r.episode)).size, 1);
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

test("apiSessions: episode keys the visit, so rows of one journey share it and others do not", async () => {
  const env = makeEnv();
  // one visitor, two visits: pv-a/pv-b chain, pv-c is an hour later
  await insertPv(env, { id: "pv-a", sa: T, d: 10_000 });
  await insertPv(env, { id: "pv-b", sa: T + 12_000, d: 5000 });
  await insertPv(env, { id: "pv-c", sa: T + 3_600_000, d: 1000 });
  // a different visitor, inside the first visit's window
  await insertPv(env, { id: "pv-other", sid: "sid-b", sa: T + 3000, d: 1000 });

  const by = Object.fromEntries((await sessions(env)).map((r) => [r.id, r]));
  // the two chained pageviews are one visit, keyed by the one that opened it,
  // and numbered by where they sit in it
  assert.equal(by["pv-a"].episode, "pv-a");
  assert.equal(by["pv-a"].leg, 1);
  assert.equal(by["pv-b"].episode, "pv-a");
  assert.equal(by["pv-b"].leg, 2);
  // a later visit by the same visitor is a different key — which the permanent
  // session_id, identical across all three, could never have told apart
  assert.equal(by["pv-c"].episode, "pv-c");
  assert.equal(by["pv-c"].leg, 1);
  assert.equal(by["pv-c"].session_id, by["pv-a"].session_id);
  // and another visitor is its own visit
  assert.equal(by["pv-other"].episode, "pv-other");
  env.DB.close();
});

test("apiSessions: a row whose episode cannot be looked up keys the visit to itself", async () => {
  const env = makeEnv();
  await insertPv(env, { id: "pv-a", sid: "", sa: T, d: 0 });
  const [row] = await sessions(env);
  assert.equal(row.session_id, "");
  assert.equal(row.pages, 1);
  assert.equal(row.episode, "pv-a");
  assert.equal(row.leg, 1);
  env.DB.close();
});

// ---------- apiSessions: active_ms ----------
//
// The measured path first: engagement is what the tracker observed, and the
// read side must hand it back untouched rather than recomputing anything.

test("apiSessions: a measured active_ms is reported as measured, whatever the events say", async () => {
  const env = makeEnv();
  // the tracker saw a visible tab and a still read; the event gaps alone would
  // have reconstructed far less, and the measurement is the one that counts
  await insertPv(env, { id: "pv-a", sa: T, d: 120_000, am: 47_000 });
  await insertAt(env, "pv-a", [1000, 120_000]);
  const [row] = await sessions(env);

  assert.equal(row.active_ms, 47_000);
  assert.equal(row.active_estimated, 0);
  env.DB.close();
});

test("apiSessions: a measured zero is an answer, not a missing one", async () => {
  const env = makeEnv();
  // hidden the whole time — prerendered, or a background tab that still fired
  // a scroll. Reconstruction would invent seconds that nobody spent here.
  await insertPv(env, { id: "pv-a", sa: T, d: 60_000, am: 0 });
  await insertAt(env, "pv-a", [1000, 2000, 60_000]);
  const [row] = await sessions(env);

  assert.equal(row.active_ms, 0);
  assert.equal(row.active_estimated, 0);
  env.DB.close();
});

// …and the reconstruction, which is only ever reached by rows written before
// the tracker measured anything — everything below leaves active_ms NULL.

test("apiSessions: active_ms counts the gaps between events, capped at the idle threshold", async () => {
  const env = makeEnv();
  // 4 minutes of wall clock, but the visitor touched the page for ~3s of it:
  // a burst at the start, four minutes of nothing, one last move.
  await insertPv(env, { id: "pv-a", sa: T, d: 243_000 });
  await insertAt(env, "pv-a", [500, 1500, 2500, 3000, 243_000]);
  const [row] = await sessions(env);

  assert.equal(row.duration_ms, 243_000);
  // 500 + 1000 + 1000 + 500 + min(240000, 4000)
  assert.equal(row.active_ms, 7000);
  assert.equal(row.active_estimated, 1);
  env.DB.close();
});

test("apiSessions: active_ms and the idle it drops add up to the wall clock", async () => {
  const env = makeEnv();
  const ts = [500, 1500, 30_000, 31_000, 90_000];
  await insertPv(env, { id: "pv-a", sa: T, d: ts[ts.length - 1] });
  await insertAt(env, "pv-a", ts);
  const [row] = await sessions(env);

  // the same partition the replay's timeline draws: every gap is either
  // attention (up to IDLE_GAP_MS of it) or idle, and nothing is counted twice
  let active = 0;
  let idle = 0;
  let prev = 0;
  for (const t of ts) {
    active += Math.min(t - prev, IDLE_GAP_MS);
    idle += Math.max(t - prev - IDLE_GAP_MS, 0);
    prev = t;
  }
  assert.equal(row.active_ms, active);
  assert.equal(Number(row.active_ms) + idle, row.duration_ms);
  env.DB.close();
});

test("apiSessions: an uninterrupted visit reports its whole span as active", async () => {
  const env = makeEnv();
  // pointer moves sample every 150ms, so continuous attention has no gap to cut
  const ts = Array.from({ length: 40 }, (_, i) => (i + 1) * 150);
  await insertPv(env, { id: "pv-a", sa: T, d: 6000 });
  await insertAt(env, "pv-a", ts);
  const [row] = await sessions(env);

  assert.equal(row.active_ms, 6000);
  assert.equal(row.active_ms, row.duration_ms);
  env.DB.close();
});

test("apiSessions: a page opened and abandoned reports the idle threshold, not the tab's life", async () => {
  const env = makeEnv();
  await insertPv(env, { id: "pv-a", sa: T, d: 1_800_000 });
  await insertAt(env, "pv-a", [1_800_000]); // half an hour, then one move
  const [row] = await sessions(env);

  assert.equal(row.active_ms, IDLE_GAP_MS);
  assert.equal(row.active_estimated, 1);
  env.DB.close();
});

test("apiSessions: a rewound or negative event time cannot subtract from active_ms", async () => {
  const env = makeEnv();
  // `t` comes off an unauthenticated beacon, so both a backwards step and an
  // outright negative offset have to floor at zero rather than eat real time
  await insertPv(env, { id: "pv-a", sa: T, d: 3000 });
  await insertAt(env, "pv-a", [1000, 2000, 500, -10_000_000, 3000]);
  const [row] = await sessions(env);

  // 1000 + 1000 + 0 (rewound) + 0 (negative) + 4000 (the jump back, capped):
  // the two backwards steps contribute nothing instead of erasing the 2000ms
  // of real activity recorded before them
  assert.equal(row.active_ms, 2000 + IDLE_GAP_MS);
  env.DB.close();
});

test("apiSessions: a wholly negative event stream reports zero, not negative, active time", async () => {
  const env = makeEnv();
  await insertPv(env, { id: "pv-a", sa: T, d: 0 });
  await insertAt(env, "pv-a", [-5000, -10_000, -20_000]);
  const [row] = await sessions(env);

  assert.equal(row.active_ms, 0);
  env.DB.close();
});

test("apiSessions: a pageview with no events reports zero active time", async () => {
  const env = makeEnv();
  await insertPv(env, { id: "pv-a", sa: T, d: 60_000 });
  const [row] = await sessions(env);

  assert.equal(row.events, 0);
  assert.equal(row.active_ms, 0);
  // still flagged: nothing was measured, and no events means nothing to rebuild
  // from either — 0 here is "we do not know", not "nobody was there"
  assert.equal(row.active_estimated, 1);
  env.DB.close();
});

test("apiSessions: active_ms is per pageview, never another row's events", async () => {
  const env = makeEnv();
  await insertPv(env, { id: "pv-a", sa: T, d: 2000 });
  await insertPv(env, { id: "pv-b", sa: T + 10_000, d: 90_000 });
  await insertAt(env, "pv-a", [1000, 2000]);
  await insertAt(env, "pv-b", [1000, 90_000]);
  const rows = await sessions(env);

  assert.deepEqual(
    rows.map((r) => [r.id, r.active_ms]),
    [
      ["pv-b", 1000 + IDLE_GAP_MS],
      ["pv-a", 2000],
    ],
  );
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

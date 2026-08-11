// The dashboard's list. Its unit is the *visit* — one uninterrupted run of
// navigation — because a session id identifies a person and never rotates, and
// a pageview is only ever part of what someone did.
import assert from "node:assert/strict";
import { test } from "node:test";
import { REPLAYS_SCAN_CAP, apiReplays, apiSites, buildVisits } from "../src/api.ts";
import { IDLE_GAP_MS } from "../src/timeline.ts";
import { apiUrl, makeEnv } from "./helpers/fake-d1.ts";
import type { TestEnv } from "./helpers/fake-d1.ts";

const T = 1_700_000_000_000;
const HOUR = 3_600_000;

interface PvSpec {
  id: string;
  sa: number;
  d?: number;
  sid?: string;
  site?: string;
  path?: string;
  am?: number | null;
  msc?: number;
  /** [kind, t] pairs, seq assigned in order */
  ev?: [string, number][];
}

async function insert(env: TestEnv, spec: PvSpec): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO pageviews (id, session_id, site, path, vw, vh, started_at, duration_ms, active_ms, max_scroll)
     VALUES (?1, ?2, ?3, ?4, 1440, 900, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      spec.id,
      spec.sid ?? "visitor-aaaa",
      spec.site ?? "testsite",
      spec.path ?? "/",
      spec.sa,
      spec.d ?? 1000,
      spec.am ?? null,
      spec.msc ?? 0,
    )
    .run();
  let seq = 0;
  for (const [k, t] of spec.ev ?? []) {
    await env.DB.prepare(
      `INSERT INTO events (pv, seq, k, sel, rx, ry, x, y, t) VALUES (?1, ?2, ?3, '#a', 0.5, 0.5, 1, 2, ?4)`,
    )
      .bind(spec.id, seq++, k, t)
      .run();
  }
}

interface VisitRow {
  episode: string;
  site: string;
  session_id: string;
  entry_path: string;
  pages: number;
  started_at: number;
  ended_at: number;
  duration_ms: number;
  active_ms: number;
  active_estimated: number;
  clicks: number;
  rage: number;
  events: number;
  max_scroll: number;
  legs: { id: string; path: string; clicks: number; rage: number; events: number; active_ms: number; active_estimated: number }[];
}

const replays = async (env: TestEnv, params: Record<string, string> = {}, now = T + HOUR) => {
  const res = await apiReplays(apiUrl("replays", params), env as never, now);
  assert.equal(res.status, 200);
  return (await res.json()) as {
    visits: VisitRow[];
    total: number;
    from: number;
    to: number;
    truncated: boolean;
    scanned: number;
  };
};

const episodes = (rows: VisitRow[]) => rows.map((v) => v.episode);

// ---------- visits ----------

test("consecutive pageviews are one visit; a long idle starts another", async () => {
  const env = makeEnv();
  await insert(env, { id: "pv-a", sa: T, d: 10_000 });
  await insert(env, { id: "pv-b", sa: T + 12_000, path: "/pricing" }); // chained to pv-a
  await insert(env, { id: "pv-c", sa: T + HOUR }); // an hour later: a new visit

  const { visits, total } = await replays(env, {}, T + 2 * HOUR);
  assert.equal(total, 2);
  assert.deepEqual(episodes(visits), ["pv-c", "pv-a"]);
  assert.deepEqual(visits.map((v) => v.pages), [1, 2]);
  // the visit is keyed by the pageview it opened with — the one a deep link
  // has to start the replay from
  assert.deepEqual(visits[1].legs.map((l) => l.id), ["pv-a", "pv-b"]);
  assert.equal(visits[1].entry_path, "/");
  assert.equal(visits[1].ended_at, T + 13_000);
  assert.equal(visits[1].duration_ms, 13_000);
  env.DB.close();
});

test("one visitor id on two sites is two visits, never one", async () => {
  const env = makeEnv();
  await insert(env, { id: "pv-a", sa: T, site: "one.example", sid: "visitor-aaaa" });
  await insert(env, { id: "pv-b", sa: T + 3000, site: "two.example", sid: "visitor-aaaa" });

  const { visits } = await replays(env);
  assert.equal(visits.length, 2);
  assert.deepEqual(
    visits.map((v) => v.site).sort(),
    ["one.example", "two.example"],
  );
  // …because a journey is fetched per site: a visit spanning two of them could
  // never be replayed
  assert.deepEqual(visits.map((v) => v.pages), [1, 1]);
  env.DB.close();
});

test("buildVisits sorts newest first and breaks ties on the id", () => {
  const leg = (id: string, started_at: number, session_id = "s1") => ({
    id,
    session_id,
    site: "s",
    path: "/",
    started_at,
    duration_ms: 0,
    active_ms: 0,
    vw: 0,
    vh: 0,
    max_scroll: 0,
  });
  // same millisecond, different visitors: an unstable order makes a paginated
  // list repeat rows and skip others
  // …so ties fall the same way the SQL scan orders them: started_at DESC, id DESC
  const visits = buildVisits([leg("pv-b", T, "s2"), leg("pv-a", T, "s1"), leg("pv-c", T + 1, "s3")]);
  assert.deepEqual(episodes(visits as unknown as VisitRow[]), ["pv-c", "pv-b", "pv-a"]);
});

// ---------- the date range ----------

test("a visit that began before the range keeps its real first leg", async () => {
  const env = makeEnv();
  // the visit starts 10s before `from` and carries on inside it
  await insert(env, { id: "pv-head", sa: T - 10_000, d: 5000 });
  await insert(env, { id: "pv-tail", sa: T + 1000 });
  // …and an untouched visit hours earlier is not in the range at all
  await insert(env, { id: "pv-old", sa: T - 5 * HOUR, sid: "visitor-bbbb" });

  const { visits } = await replays(env, { from: String(T) });
  assert.deepEqual(episodes(visits), ["pv-head"]);
  assert.deepEqual(visits[0].legs.map((l) => l.id), ["pv-head", "pv-tail"]);
  env.DB.close();
});

test("the range excludes what ended before it and what starts after it", async () => {
  const env = makeEnv();
  await insert(env, { id: "pv-before", sa: T - 2 * HOUR, sid: "visitor-aaaa" });
  await insert(env, { id: "pv-inside", sa: T + HOUR, sid: "visitor-bbbb" });
  await insert(env, { id: "pv-after", sa: T + 5 * HOUR, sid: "visitor-cccc" });

  const { visits } = await replays(
    env,
    { from: String(T), to: String(T + 2 * HOUR) },
    T + 6 * HOUR,
  );
  assert.deepEqual(episodes(visits), ["pv-inside"]);
  env.DB.close();
});

test("a YYYY-MM-DD bound is read as a UTC day, and junk falls back instead of matching nothing", async () => {
  const env = makeEnv();
  await insert(env, { id: "pv-1", sa: Date.parse("2024-03-15T12:00:00Z") });

  const day = await replays(
    env,
    { from: "2024-03-15", to: "2024-03-16" },
    Date.parse("2024-04-01T00:00:00Z"),
  );
  assert.deepEqual(episodes(day.visits), ["pv-1"]);

  const before = await replays(
    env,
    { from: "2024-03-16", to: "2024-03-17" },
    Date.parse("2024-04-01T00:00:00Z"),
  );
  assert.deepEqual(episodes(before.visits), []);

  const junk = await replays(env, { from: "yesterday", to: "" }, Date.parse("2024-04-01T00:00:00Z"));
  assert.deepEqual(episodes(junk.visits), ["pv-1"], "an unparseable bound must not empty the list");
  env.DB.close();
});

// ---------- filters ----------

test("hiding a visitor removes their visits and nobody else's", async () => {
  const env = makeEnv();
  await insert(env, { id: "pv-mine", sa: T, sid: "visitor-aaaa" });
  await insert(env, { id: "pv-theirs", sa: T + 1000, sid: "visitor-bbbb" });

  assert.deepEqual(episodes((await replays(env)).visits).sort(), ["pv-mine", "pv-theirs"]);
  assert.deepEqual(episodes((await replays(env, { exclude: "visitor-aaaa" })).visits), [
    "pv-theirs",
  ]);
  assert.deepEqual(
    episodes((await replays(env, { exclude: "visitor-aaaa,visitor-bbbb" })).visits),
    [],
  );
  env.DB.close();
});

test("a malformed hidden id is dropped, not turned into a NOT IN that matches nothing", async () => {
  const env = makeEnv();
  await insert(env, { id: "pv-1", sa: T, sid: "visitor-aaaa" });

  // SQLite: `x NOT IN (a, NULL)` is NULL for every row — an empty list, an
  // empty string or a stray comma would silently return no visits at all
  for (const exclude of ["", ",", " , ", "no", "visitor-bbbb,", ",,visitor-bbbb"]) {
    assert.deepEqual(
      episodes((await replays(env, { exclude })).visits),
      ["pv-1"],
      JSON.stringify(exclude),
    );
  }
  env.DB.close();
});

test("path search matches any leg of a visit, not just the one it entered on", async () => {
  const env = makeEnv();
  await insert(env, { id: "pv-a", sa: T, d: 1000, path: "/" });
  await insert(env, { id: "pv-b", sa: T + 2000, path: "/pricing" });
  await insert(env, { id: "pv-c", sa: T + HOUR, path: "/blog", sid: "visitor-bbbb" });

  const hit = await replays(env, { q: "pric" }, T + 2 * HOUR);
  assert.deepEqual(episodes(hit.visits), ["pv-a"], "found by a leg it did not start on");
  assert.equal(hit.total, 1);

  assert.deepEqual(episodes((await replays(env, { q: "BLOG" }, T + 2 * HOUR)).visits), ["pv-c"]);
  assert.deepEqual(episodes((await replays(env, { q: "nope" }, T + 2 * HOUR)).visits), []);
  env.DB.close();
});

test("the site filter narrows to one site", async () => {
  const env = makeEnv();
  await insert(env, { id: "pv-one", sa: T, site: "one.example" });
  await insert(env, { id: "pv-two", sa: T + 1000, site: "two.example" });

  assert.deepEqual(episodes((await replays(env, { site: "one.example" })).visits), ["pv-one"]);
  assert.deepEqual(episodes((await replays(env, { site: "nosuch" })).visits), []);
  env.DB.close();
});

test("paging walks every visit once, and total counts them all", async () => {
  const env = makeEnv();
  for (let i = 0; i < 5; i++) {
    await insert(env, { id: `pv-${i}`, sa: T + i * HOUR, sid: `visitor-${i}` });
  }

  const seen: string[] = [];
  for (const offset of ["0", "2", "4"]) {
    const page = await replays(env, { limit: "2", offset }, T + 10 * HOUR);
    assert.equal(page.total, 5);
    seen.push(...episodes(page.visits));
  }
  assert.deepEqual(seen, ["pv-4", "pv-3", "pv-2", "pv-1", "pv-0"]);
  env.DB.close();
});

// ---------- per-leg statistics ----------

test("each leg carries its own counts and the visit carries the sums", async () => {
  const env = makeEnv();
  await insert(env, {
    id: "pv-a",
    sa: T,
    d: 4000,
    msc: 40,
    ev: [
      ["c", 100],
      ["c", 200],
      ["r", 300],
      ["m", 400],
    ],
  });
  await insert(env, { id: "pv-b", sa: T + 5000, path: "/x", msc: 90, ev: [["c", 100]] });

  const { visits } = await replays(env);
  const visit = visits[0];
  assert.equal(visit.pages, 2);
  assert.equal(visit.clicks, 3);
  assert.equal(visit.rage, 1);
  assert.equal(visit.events, 5);
  assert.equal(visit.max_scroll, 90, "the deepest scroll of any leg");
  assert.deepEqual(visit.legs.map((l) => l.clicks), [2, 1]);
  assert.deepEqual(visit.legs.map((l) => l.rage), [1, 0]);
  assert.deepEqual(visit.legs.map((l) => l.events), [4, 1]);
  env.DB.close();
});

test("measured engaged time is reported as measured; an unmeasured leg is a flagged floor", async () => {
  const env = makeEnv();
  // measured: the column is the answer, whatever the events say
  await insert(env, { id: "pv-measured", sa: T, d: 60_000, am: 7000, ev: [["c", 100], ["c", 60_000]] });
  const measured = (await replays(env)).visits[0];
  assert.equal(measured.active_ms, 7000);
  assert.equal(measured.active_estimated, 0);

  // never measured: rebuilt from the gaps, each capped at IDLE_GAP_MS, and
  // said to be an estimate
  const env2 = makeEnv();
  await insert(env2, {
    id: "pv-unmeasured",
    sa: T,
    d: 60_000,
    am: null,
    ev: [["c", 1000], ["c", 60_000]],
  });
  const est = (await replays(env2)).visits[0];
  assert.equal(est.active_estimated, 1);
  assert.equal(est.active_ms, 1000 + IDLE_GAP_MS, "the 59s gap counts for one idle threshold");

  // a measured zero is a real answer and stays one
  const env3 = makeEnv();
  await insert(env3, { id: "pv-zero", sa: T, d: 5000, am: 0, ev: [["c", 100]] });
  const zero = (await replays(env3)).visits[0];
  assert.equal(zero.active_ms, 0);
  assert.equal(zero.active_estimated, 0);

  env.DB.close();
  env2.DB.close();
  env3.DB.close();
});

test("one unmeasured leg makes the whole visit's engaged time a flagged floor", async () => {
  const env = makeEnv();
  await insert(env, { id: "pv-a", sa: T, d: 1000, am: 900, ev: [["c", 100]] });
  await insert(env, { id: "pv-b", sa: T + 2000, d: 1000, am: null, ev: [["c", 100]] });

  const visit = (await replays(env)).visits[0];
  assert.equal(visit.active_estimated, 1);
  assert.deepEqual(visit.legs.map((l) => l.active_estimated), [0, 1]);
  env.DB.close();
});

// ---------- empties and bounds ----------

test("a visit with nothing recorded is not listed, but an empty leg cannot split one", async () => {
  const env = makeEnv();
  // a pageview whose wall clock never moved: the beacon carried no events
  await insert(env, { id: "pv-empty", sa: T, d: 0, sid: "visitor-bbbb" });
  // …the same thing in the middle of a real visit must still hold it together
  await insert(env, { id: "pv-a", sa: T + HOUR, d: 2000, ev: [["c", 100]] });
  await insert(env, { id: "pv-mid", sa: T + HOUR + 3000, d: 0 });
  await insert(env, { id: "pv-c", sa: T + HOUR + 5000, d: 2000, ev: [["c", 100]] });

  const { visits, total } = await replays(env, {}, T + 2 * HOUR);
  assert.equal(total, 1);
  assert.deepEqual(episodes(visits), ["pv-a"]);
  assert.deepEqual(visits[0].legs.map((l) => l.id), ["pv-a", "pv-mid", "pv-c"]);

  const withEmpty = await replays(env, { empty: "1" }, T + 2 * HOUR);
  assert.deepEqual(episodes(withEmpty.visits), ["pv-a", "pv-empty"]);
  env.DB.close();
});

test("the scan is capped and says so", async () => {
  const env = makeEnv();
  // one visit per row: every pageview gets its own visitor
  env.DB.db.exec(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${REPLAYS_SCAN_CAP + 1})
     INSERT INTO pageviews (id, session_id, site, path, vw, vh, started_at, duration_ms, active_ms, max_scroll)
     SELECT 'pv-' || i, 'visitor-' || i, 'testsite', '/', 1440, 900, ${T} + i * 1000, 500, 0, 0 FROM n`,
  );

  const page = await replays(env, { limit: "5" }, T + 10 * HOUR);
  assert.equal(page.scanned, REPLAYS_SCAN_CAP);
  assert.equal(page.truncated, true);
  assert.equal(page.total, REPLAYS_SCAN_CAP);
  assert.equal(page.visits.length, 5);
  // the newest survive the cap, which is the half a dashboard is looking at
  assert.equal(page.visits[0].episode, `pv-${REPLAYS_SCAN_CAP + 1}`);
  env.DB.close();
});

test("a page of visits stays under D1's bound-parameter ceiling", async () => {
  const env = makeEnv();
  // 100 legs in one visit, requested in one page: the statistics lookup has to
  // chunk its id list or FakeD1 throws the way D1 would
  for (let i = 0; i < 100; i++) {
    await insert(env, { id: `pv-${i}`, sa: T + i * 2000, d: 1000, ev: [["c", 100]] });
  }
  const { visits } = await replays(env, { limit: "100" }, T + 10 * HOUR);
  assert.equal(visits.length, 1);
  assert.equal(visits[0].pages, 100);
  assert.equal(visits[0].clicks, 100);
  env.DB.close();
});

// ---------- sites ----------

test("apiSites lists what is reporting, newest first", async () => {
  const env = makeEnv();
  await insert(env, { id: "pv-1", sa: T, site: "one.example", sid: "visitor-aaaa" });
  await insert(env, { id: "pv-2", sa: T + 1000, site: "one.example", sid: "visitor-bbbb" });
  await insert(env, { id: "pv-3", sa: T + 2000, site: "two.example", sid: "visitor-aaaa" });

  const res = await apiSites(apiUrl("sites"), env as never, T + HOUR);
  assert.equal(res.status, 200);
  const { sites } = (await res.json()) as {
    sites: { site: string; pageviews: number; visitors: number; last_seen: number }[];
  };
  assert.deepEqual(sites, [
    { site: "two.example", pageviews: 1, visitors: 1, last_seen: T + 2000 },
    { site: "one.example", pageviews: 2, visitors: 2, last_seen: T + 1000 },
  ]);

  const ranged = await apiSites(apiUrl("sites", { from: String(T + 1500) }), env as never, T + HOUR);
  assert.deepEqual(
    ((await ranged.json()) as { sites: { site: string }[] }).sites.map((s) => s.site),
    ["two.example"],
  );
  env.DB.close();
});

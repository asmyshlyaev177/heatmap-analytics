import assert from "node:assert/strict";
import { test } from "node:test";
import { collect, purge } from "../src/api.ts";
import { FakeD1, beacon, ev, makeEnv, pageview } from "./helpers/fake-d1.ts";
import type { TestEnv } from "./helpers/fake-d1.ts";

const DAY = 86_400_000;
// 2023-11-14T22:13:20.000Z — fixed so every cutoff below is exact
const NOW = 1_700_000_000_000;

const seed = async (
  env: TestEnv,
  id: string,
  startedAt: number,
  evs: Record<string, unknown>[] = [ev("c", 10), ev("m", 20)],
) => {
  const res = await collect(beacon(pageview({ pv: id, sa: startedAt, ev: evs })), env as never);
  assert.equal(res.status, 204);
};

const ids = (db: FakeD1) =>
  db.rows<{ id: string }>(`SELECT id FROM pageviews ORDER BY id`).map((r) => r.id);

const evPvs = (db: FakeD1) =>
  db.rows<{ pv: string }>(`SELECT DISTINCT pv FROM events ORDER BY pv`).map((r) => r.pv);

// events whose pageview no longer exists — purge must never leave these behind
const orphanEvents = (db: FakeD1) =>
  Number(
    db.rows<{ n: number }>(
      `SELECT COUNT(*) AS n FROM events e LEFT JOIN pageviews p ON p.id = e.pv WHERE p.id IS NULL`,
    )[0].n,
  );

// node:sqlite hands back null-prototype rows; flatten them so deepEqual can be
// compared against plain object literals
const plain = (rows: Record<string, unknown>[]) => rows.map((r) => ({ ...r }));

const snapshot = (db: FakeD1) => ({
  pageviews: plain(db.rows(`SELECT * FROM pageviews ORDER BY id`)),
  events: plain(db.rows(`SELECT * FROM events ORDER BY pv, seq`)),
});

test("default 30-day retention drops expired pageviews with all their events", async () => {
  const env = makeEnv();
  await seed(env, "old", NOW - 31 * DAY);
  await seed(env, "fresh", NOW - 29 * DAY);
  assert.equal(env.DB.count("pageviews"), 2);
  assert.equal(env.DB.count("events"), 4);
  // one visitor id across both pageviews => one session spanning both, so this
  // also proves expiry is per-pageview, not per-session
  const sids = env.DB.rows<{ session_id: string }>(`SELECT DISTINCT session_id FROM pageviews`);
  assert.equal(sids.length, 1);

  await purge(env, NOW);

  assert.deepEqual(ids(env.DB), ["fresh"]);
  assert.deepEqual(evPvs(env.DB), ["fresh"]);
  assert.equal(env.DB.count("events"), 2);
  assert.equal(orphanEvents(env.DB), 0);
  env.DB.close();
});

test("surviving pageview and its events are left byte-for-byte intact", async () => {
  const env = makeEnv();
  await seed(env, "old", NOW - 200 * DAY);
  await seed(env, "fresh", NOW - 2 * DAY, [ev("c", 10), ev("s", 20, { y: 640 })]);
  const before = snapshot(env.DB);
  const keptPv = before.pageviews.find((r) => (r as { id: string }).id === "fresh");
  const keptEvents = before.events.filter((r) => (r as { pv: string }).pv === "fresh");

  await purge(env, NOW);

  const after = snapshot(env.DB);
  assert.deepEqual(after.pageviews, [keptPv]);
  assert.deepEqual(after.events, keptEvents);
  // pin the exact stored shape so a rewrite of the delete can't quietly
  // rewrite rows it keeps
  assert.deepEqual(after.events, [
    { pv: "fresh", seq: 10, k: "c", sel: "#target", rx: 0.5, ry: 0.5, x: 100, y: 200, t: 10 },
    { pv: "fresh", seq: 20, k: "s", sel: null, rx: null, ry: null, x: null, y: 640, t: 20 },
  ]);
  env.DB.close();
});

test("cutoff boundary: exactly at the cutoff survives, one ms older is deleted", async () => {
  const env = makeEnv();
  const cutoff = NOW - 30 * DAY;
  await seed(env, "before", cutoff - 1);
  await seed(env, "at", cutoff);
  await seed(env, "after", cutoff + 1);

  await purge(env, NOW);

  assert.deepEqual(ids(env.DB), ["after", "at"]);
  assert.deepEqual(evPvs(env.DB), ["after", "at"]);
  assert.equal(env.DB.count("events"), 4);
  assert.equal(orphanEvents(env.DB), 0);
  env.DB.close();
});

test("RETENTION_DAYS shortens the window", async () => {
  const short = makeEnv({ RETENTION_DAYS: "7" });
  await seed(short, "ten-days", NOW - 10 * DAY);
  await seed(short, "six-days", NOW - 6 * DAY);
  await purge(short, NOW);
  assert.deepEqual(ids(short.DB), ["six-days"]);
  assert.equal(orphanEvents(short.DB), 0);
  short.DB.close();

  // the same 10-day-old pageview is comfortably inside the 30-day default
  const def = makeEnv();
  await seed(def, "ten-days", NOW - 10 * DAY);
  await purge(def, NOW);
  assert.deepEqual(ids(def.DB), ["ten-days"]);
  def.DB.close();
});

test("RETENTION_DAYS of 1 keeps only the last 24h", async () => {
  const env = makeEnv({ RETENTION_DAYS: "1" });
  await seed(env, "yesterday", NOW - DAY - 1);
  await seed(env, "hours-ago", NOW - 6 * 3_600_000);
  await purge(env, NOW);
  assert.deepEqual(ids(env.DB), ["hours-ago"]);
  env.DB.close();
});

test("zero or unparseable RETENTION_DAYS falls back to 30 days, not to wiping everything", async () => {
  // int() rounds, so "0.4" also lands on 0 and takes the fallback
  for (const value of ["0", "-0", "", "abc", "0.4", "null", "NaN", "  "]) {
    const env = makeEnv({ RETENTION_DAYS: value });
    await seed(env, "ten-days", NOW - 10 * DAY);
    await seed(env, "ancient", NOW - 91 * DAY);
    await purge(env, NOW);
    assert.deepEqual(ids(env.DB), ["ten-days"], `RETENTION_DAYS=${JSON.stringify(value)}`);
    assert.deepEqual(evPvs(env.DB), ["ten-days"], `RETENTION_DAYS=${JSON.stringify(value)}`);
    env.DB.close();
  }
});

test("negative RETENTION_DAYS clamps to a 1-day floor instead of a future cutoff", async () => {
  // Math.max(1, -5) — a negative window would otherwise put the cutoff in the
  // future and delete rows that have not aged at all
  const env = makeEnv({ RETENTION_DAYS: "-5" });
  await seed(env, "two-days", NOW - 2 * DAY);
  await seed(env, "now-ish", NOW - 1000);
  await purge(env, NOW);
  assert.deepEqual(ids(env.DB), ["now-ish"]);
  assert.equal(env.DB.count("events"), 2);
  assert.equal(orphanEvents(env.DB), 0);
  env.DB.close();
});

test("purge is idempotent", async () => {
  const env = makeEnv({ RETENTION_DAYS: "30" });
  await seed(env, "old", NOW - 31 * DAY);
  await seed(env, "fresh", NOW - 29 * DAY);

  await purge(env, NOW);
  const after = snapshot(env.DB);
  await purge(env, NOW);
  await purge(env, NOW);

  assert.deepEqual(snapshot(env.DB), after);
  assert.deepEqual(ids(env.DB), ["fresh"]);
  assert.equal(env.DB.count("events"), 2);
  env.DB.close();
});

test("purge on an empty database is a no-op", async () => {
  const env = makeEnv();
  await purge(env, NOW);
  assert.equal(env.DB.count("pageviews"), 0);
  assert.equal(env.DB.count("events"), 0);
  env.DB.close();
});

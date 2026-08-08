import assert from "node:assert/strict";
import { test } from "node:test";
import { collect } from "../src/api.ts";
import { FakeD1, beacon, ev, makeEnv, pageview } from "./helpers/fake-d1.ts";

test("fake D1 applies the real schema", () => {
  const db = new FakeD1();
  const tables = db
    .rows<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .map((r) => r.name);
  assert.deepEqual(tables, ["events", "pageviews"]);
  db.close();
});

test("collect() ingests a beacon into pageviews + events", async () => {
  const env = makeEnv();
  const res = await collect(beacon(pageview({ ev: [ev("c", 100), ev("m", 200)] })), env as never);
  assert.equal(res.status, 204);
  assert.equal(env.DB.count("pageviews"), 1);
  assert.equal(env.DB.count("events"), 2);
  env.DB.close();
});

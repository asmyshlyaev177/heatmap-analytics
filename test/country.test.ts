// Where the visitor was, as the edge resolved it. The guarantee that no IP is
// read or stored is asserted in collect.test.ts and holds with this column.
import assert from "node:assert/strict";
import { test } from "node:test";
import { apiReplays, collect, country } from "../src/api/index.ts";
import { apiUrl, beacon, makeEnv, pageview } from "./helpers/fake-d1.ts";

const HOUR = 3_600_000;

const req = (headers: Record<string, string>) =>
  new Request("https://collector.test/collect", { method: "POST", headers });

const pvCountry = (env: ReturnType<typeof makeEnv>, id = "pv-1") =>
  env.DB.rows<{ country: string | null }>(`SELECT country FROM pageviews WHERE id = ?`, id)[0]
    .country;

test("country() takes a two-letter code from the edge and nothing else", () => {
  assert.equal(country(req({ "CF-IPCountry": "DE" })), "DE");
  assert.equal(country(req({ "CF-IPCountry": "US" })), "US");

  // Cloudflare's two non-answers: unplaceable, and Tor. Both spell NULL.
  assert.equal(country(req({ "CF-IPCountry": "XX" })), null);
  assert.equal(country(req({ "CF-IPCountry": "T1" })), null);

  // No edge set it: wrangler dev, the e2e endpoint, a host that doesn't.
  assert.equal(country(req({})), null);

  // A header is a header: anything off-shape is refused, not stored.
  for (const junk of ["de", "DEU", "D", "", "D3", "de-DE", "US; DROP"]) {
    assert.equal(country(req({ "CF-IPCountry": junk })), null, junk);
  }
});

test("collect stores the country of the beacon, and no country at all off the edge", async () => {
  const env = makeEnv();
  await collect(beacon(pageview({ pv: "pv-de" }), { country: "DE" }), env as never);
  await collect(beacon(pageview({ pv: "pv-none" }), { country: null }), env as never);

  assert.equal(pvCountry(env, "pv-de"), "DE");
  assert.equal(pvCountry(env, "pv-none"), null);
  env.DB.close();
});

test("a later flush of the same pageview cannot move it to another country", async () => {
  const env = makeEnv();
  await collect(beacon(pageview({ pv: "pv-1", d: 1000 }), { country: "DE" }), env as never);
  // a VPN flipped mid-read: the visit stays put, the growing columns still grow
  await collect(beacon(pageview({ pv: "pv-1", d: 9000 }), { country: "US" }), env as never);

  assert.equal(pvCountry(env), "DE");
  assert.equal(
    env.DB.rows<{ duration_ms: number }>(`SELECT duration_ms FROM pageviews WHERE id = 'pv-1'`)[0]
      .duration_ms,
    9000,
  );
  env.DB.close();
});

test("the visit reports the country it opened in", async () => {
  const env = makeEnv();
  const T = 1_700_000_000_000;
  await collect(beacon(pageview({ pv: "pv-a", sa: T, d: 1000 }), { country: "DE" }), env as never);
  await collect(
    beacon(pageview({ pv: "pv-b", sa: T + 3000, d: 1000 }), { country: "US" }),
    env as never,
  );

  const res = await apiReplays(apiUrl("replays", { from: String(T - 1) }), env as never, T + HOUR);
  const { visits } = (await res.json()) as {
    visits: { episode: string; pages: number; country: string | null }[];
  };
  assert.equal(visits.length, 1, "one visitor navigating is one visit");
  assert.equal(visits[0].pages, 2);
  assert.equal(visits[0].country, "DE");
  env.DB.close();
});

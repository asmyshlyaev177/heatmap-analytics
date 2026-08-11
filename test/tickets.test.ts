// A replay deep link runs on the recorded page, which is not the owner's
// origin — so what authorises it is a ticket, not the VIEWER_TOKEN. These are
// the bounds that make that trade safe: minutes of validity, one visitor, one
// site, and no way to widen any of the three.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TICKET_TTL_MS,
  apiJourney,
  apiReplay,
  apiTicketMint,
  apiTicketResolve,
  authenticate,
  collect,
  purge,
} from "../src/api.ts";
import type { Auth } from "../src/api.ts";
import { apiUrl, beacon, ev, makeEnv, pageview } from "./helpers/fake-d1.ts";
import type { TestEnv } from "./helpers/fake-d1.ts";

const T = 1_700_000_000_000;

const seed = (env: TestEnv, over: Record<string, unknown> = {}) =>
  collect(beacon(pageview({ ev: [ev("c", 100)], ...over })), env as never, T);

interface Minted {
  tk: string;
  pv: string;
  site: string;
  path: string;
  expires_at: number;
}

const mint = async (env: TestEnv, pv: string, now = T): Promise<Minted> => {
  const res = await apiTicketMint(apiUrl("ticket", { pv }), env as never, now);
  assert.equal(res.status, 200);
  return (await res.json()) as Minted;
};

const auth = (env: TestEnv, tk: string, now = T) =>
  authenticate(apiUrl("replay", { tk }), env as never, now);

test("a ticket is scoped by the recording, not by the caller", async () => {
  const env = makeEnv();
  await seed(env, { pv: "pv-1", site: "testsite", path: "/pricing", sid: "visitor-aaaa" });

  const t = await mint(env, "pv-1");
  assert.equal(t.pv, "pv-1");
  assert.equal(t.site, "testsite");
  assert.equal(t.path, "/pricing");
  assert.equal(t.expires_at, T + TICKET_TTL_MS);
  assert.match(t.tk, /^[\w-]{16,64}$/);

  const a = (await auth(env, t.tk)) as Extract<Auth, { kind: "ticket" }>;
  assert.equal(a.kind, "ticket");
  assert.equal(a.site, "testsite");
  assert.equal(a.pv, "pv-1");
  assert.equal(a.sid, "visitor-aaaa");
  env.DB.close();
});

test("minting refuses a pageview that does not exist", async () => {
  const env = makeEnv();
  await seed(env, { pv: "pv-1" });
  const res = await apiTicketMint(apiUrl("ticket", { pv: "pv-nope" }), env as never, T);
  assert.equal(res.status, 404);
  assert.equal(env.DB.count("replay_tickets"), 0);
  env.DB.close();
});

test("a ticket stops working the moment it expires", async () => {
  const env = makeEnv();
  await seed(env, { pv: "pv-1" });
  const t = await mint(env, "pv-1");

  assert.ok(await auth(env, t.tk, t.expires_at - 1), "valid up to its last millisecond");
  assert.equal(await auth(env, t.tk, t.expires_at), null, "not at the boundary");
  assert.equal(await auth(env, t.tk, t.expires_at + 1), null, "and not after");
  env.DB.close();
});

test("an unknown or malformed ticket authenticates nothing", async () => {
  const env = makeEnv();
  await seed(env, { pv: "pv-1" });
  await mint(env, "pv-1");

  for (const tk of ["", "short", "not a ticket", "../../etc/passwd", "%", "a".repeat(65)]) {
    assert.equal(await auth(env, tk), null, tk);
  }
  assert.equal(await auth(env, "0123456789abcdef"), null, "well-shaped but never minted");
  env.DB.close();
});

test("the token still authenticates, and outranks a ticket presented beside it", async () => {
  const env = makeEnv();
  await seed(env, { pv: "pv-1" });
  const t = await mint(env, "pv-1");

  const url = apiUrl("replay", { t: "test-token", tk: t.tk });
  assert.deepEqual(await authenticate(url, env as never, T), { kind: "token" });
  // …and an expired ticket cannot demote a request the token already answered
  assert.deepEqual(
    await authenticate(url, env as never, t.expires_at + 1),
    { kind: "token" },
  );
  env.DB.close();
});

test("a ticket reads its own visitor's journey and legs", async () => {
  const env = makeEnv();
  await seed(env, { pv: "pv-1", path: "/", sid: "visitor-aaaa", d: 5000 });
  await seed(env, { pv: "pv-2", path: "/pricing", sid: "visitor-aaaa", sa: T + 6000 });
  const t = await mint(env, "pv-1");
  const a = (await auth(env, t.tk)) as Auth;

  const journey = await apiJourney(
    apiUrl("journey", { site: "testsite", sid: "visitor-aaaa", pv: "pv-1" }),
    env as never,
    a,
  );
  assert.equal(journey.status, 200);
  assert.deepEqual(
    ((await journey.json()) as { pageviews: { id: string }[] }).pageviews.map((p) => p.id),
    ["pv-1", "pv-2"],
  );

  // every leg of that journey, including the one the ticket does not name
  for (const pv of ["pv-1", "pv-2"]) {
    const res = await apiReplay(apiUrl("replay", { pv }), env as never, a);
    assert.equal(res.status, 200, pv);
  }
  env.DB.close();
});

test("a ticket cannot read another visitor, another site, or another visitor's pageview", async () => {
  const env = makeEnv();
  await seed(env, { pv: "pv-mine", sid: "visitor-aaaa", site: "testsite" });
  await seed(env, { pv: "pv-theirs", sid: "visitor-bbbb", site: "testsite" });
  await seed(env, { pv: "pv-elsewhere", sid: "visitor-aaaa", site: "othersite" });
  const t = await mint(env, "pv-mine");
  const a = (await auth(env, t.tk)) as Auth;

  const forbidden = async (res: Response, label: string) => {
    assert.equal(res.status, 403, label);
    assert.deepEqual(await res.json(), { error: "forbidden" }, label);
  };

  await forbidden(
    await apiJourney(
      apiUrl("journey", { site: "testsite", sid: "visitor-bbbb" }),
      env as never,
      a,
    ),
    "another visitor's journey",
  );
  await forbidden(
    await apiJourney(
      apiUrl("journey", { site: "othersite", sid: "visitor-aaaa" }),
      env as never,
      a,
    ),
    "the same visitor id on another site",
  );
  // /api/replay takes a bare pageview id — no site, no session — so this is
  // the check that keeps a ticket off every other recording in the database
  await forbidden(
    await apiReplay(apiUrl("replay", { pv: "pv-theirs" }), env as never, a),
    "another visitor's pageview",
  );
  await forbidden(
    await apiReplay(apiUrl("replay", { pv: "pv-elsewhere" }), env as never, a),
    "the same visitor on another site",
  );
  env.DB.close();
});

test("the token reads all of it, with no ticket in sight", async () => {
  const env = makeEnv();
  await seed(env, { pv: "pv-theirs", sid: "visitor-bbbb" });
  const res = await apiReplay(apiUrl("replay", { pv: "pv-theirs" }), env as never);
  assert.equal(res.status, 200);
  env.DB.close();
});

test("resolving a ticket tells the viewer what it was sent to play", async () => {
  const env = makeEnv();
  await seed(env, { pv: "pv-1", site: "testsite", sid: "visitor-aaaa" });
  const t = await mint(env, "pv-1");
  const a = (await auth(env, t.tk)) as Auth;

  const res = await apiTicketResolve(apiUrl("ticket", { tk: t.tk }), env as never, a);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    site: "testsite",
    pv: "pv-1",
    sid: "visitor-aaaa",
    expires_at: t.expires_at,
  });

  // the owner may look one up by name; naming nothing is a bad request
  const byToken = await apiTicketResolve(apiUrl("ticket", { tk: t.tk }), env as never, {
    kind: "token",
  });
  assert.equal(byToken.status, 200);
  const none = await apiTicketResolve(apiUrl("ticket"), env as never, { kind: "token" });
  assert.equal(none.status, 400);
  env.DB.close();
});

test("resolving is a read, so one link can play a journey of many legs", async () => {
  const env = makeEnv();
  await seed(env, { pv: "pv-1" });
  const t = await mint(env, "pv-1");
  const a = (await auth(env, t.tk)) as Auth;
  for (let i = 0; i < 3; i++) {
    const res = await apiTicketResolve(apiUrl("ticket", { tk: t.tk }), env as never, a);
    assert.equal(res.status, 200, `read ${i + 1}`);
  }
  assert.equal(env.DB.count("replay_tickets"), 1);
  env.DB.close();
});

test("the nightly purge sweeps expired tickets and leaves live ones alone", async () => {
  const env = makeEnv();
  await seed(env, { pv: "pv-1" });
  const stale = await mint(env, "pv-1", T);
  const fresh = await mint(env, "pv-1", T + TICKET_TTL_MS);
  assert.equal(env.DB.count("replay_tickets"), 2);

  // the sweep runs against the clock, not the retention horizon: a ticket
  // measured in minutes must not sit in the table for thirty days
  await purge(env as never, stale.expires_at + 1);
  assert.deepEqual(
    env.DB.rows<{ id: string }>(`SELECT id FROM replay_tickets`).map((r) => r.id),
    [fresh.tk],
  );
  env.DB.close();
});

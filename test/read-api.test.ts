import assert from "node:assert/strict";
import { test } from "node:test";
import { apiElements, apiHeatmap, apiReplay, authorized, collect } from "../src/api.ts";
import { SID, apiUrl, beacon, ev, makeEnv, pageview } from "./helpers/fake-d1.ts";

type Env = ReturnType<typeof makeEnv>;
interface Point {
  sel: string;
  rx: number;
  ry: number;
  n: number;
}
interface Element {
  sel: string;
  k: string;
  n: number;
}

async function seed(env: Env, body: Record<string, unknown>): Promise<void> {
  const res = await collect(beacon(pageview(body)), env as never);
  assert.equal(res.status, 204);
}

const points = async (env: Env, params: Record<string, string>): Promise<Point[]> => {
  const res = await apiHeatmap(apiUrl("heatmap", params), env as never);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { points: Point[] };
  return body.points;
};

const elements = async (env: Env, params: Record<string, string>): Promise<Element[]> => {
  const res = await apiElements(apiUrl("elements", params), env as never);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { elements: Element[] };
  return body.elements;
};

const bySel = (rows: { sel: string }[]) => [...rows].sort((a, b) => a.sel.localeCompare(b.sel));

test("authorized() truth table", () => {
  const url = (t?: string) => apiUrl("heatmap", t === undefined ? {} : { t });

  // an unconfigured viewer token must never authorize, whatever ?t= claims
  assert.equal(authorized(url("test-token"), { VIEWER_TOKEN: undefined } as never), false);
  assert.equal(authorized(url(""), { VIEWER_TOKEN: undefined } as never), false);
  assert.equal(authorized(url(undefined), { VIEWER_TOKEN: undefined } as never), false);
  // empty-string token is falsy: still no access, even on an exact match
  assert.equal(authorized(url(""), { VIEWER_TOKEN: "" } as never), false);

  assert.equal(authorized(url("wrong"), { VIEWER_TOKEN: "test-token" } as never), false);
  assert.equal(authorized(url("test-tokenx"), { VIEWER_TOKEN: "test-token" } as never), false);
  assert.equal(authorized(url("Test-Token"), { VIEWER_TOKEN: "test-token" } as never), false);
  assert.equal(authorized(url(undefined), { VIEWER_TOKEN: "test-token" } as never), false);
  assert.equal(authorized(url("test-token"), { VIEWER_TOKEN: "test-token" } as never), true);
});

test("apiHeatmap groups repeats into one point and returns only the requested kind", async () => {
  const env = makeEnv();
  await seed(env, {
    ev: [
      ev("c", 100, { el: "#a", rx: 0.5, ry: 0.5 }),
      ev("c", 200, { el: "#a", rx: 0.5, ry: 0.5 }),
      ev("m", 300, { el: "#a", rx: 0.5, ry: 0.5 }),
      ev("r", 400, { el: "#a", rx: 0.5, ry: 0.5 }),
      ev("s", 500),
    ],
  });

  assert.deepEqual(await points(env, { site: "testsite", path: "/", type: "click" }), [
    { sel: "#a", rx: 0.5, ry: 0.5, n: 2 },
  ]);
  assert.deepEqual(await points(env, { site: "testsite", path: "/", type: "move" }), [
    { sel: "#a", rx: 0.5, ry: 0.5, n: 1 },
  ]);
  assert.deepEqual(await points(env, { site: "testsite", path: "/", type: "rage" }), [
    { sel: "#a", rx: 0.5, ry: 0.5, n: 1 },
  ]);
  // absent or unrecognised type falls back to clicks
  assert.deepEqual(await points(env, { site: "testsite", path: "/" }), [
    { sel: "#a", rx: 0.5, ry: 0.5, n: 2 },
  ]);
  assert.deepEqual(await points(env, { site: "testsite", path: "/", type: "scroll" }), [
    { sel: "#a", rx: 0.5, ry: 0.5, n: 2 },
  ]);
  env.DB.close();
});

test("apiHeatmap rounds rx/ry to 2 decimals and merges points that round together", async () => {
  const env = makeEnv();
  await seed(env, {
    ev: [
      ev("c", 100, { el: "#a", rx: 0.4512, ry: 0.6789 }),
      ev("c", 200, { el: "#a", rx: 0.4488, ry: 0.6789 }),
      ev("c", 300, { el: "#a", rx: 0.9, ry: 0.6789 }),
      ev("c", 400, { el: "#b", rx: 0.4512, ry: 0.6789 }),
    ],
  });

  const got = await points(env, { site: "testsite", path: "/", type: "click" });
  assert.deepEqual(
    [...got].sort((a, b) => a.sel.localeCompare(b.sel) || a.rx - b.rx),
    [
      { sel: "#a", rx: 0.45, ry: 0.68, n: 2 },
      { sel: "#a", rx: 0.9, ry: 0.68, n: 1 },
      { sel: "#b", rx: 0.45, ry: 0.68, n: 1 },
    ],
  );
  env.DB.close();
});

test("apiHeatmap filters by viewport width range", async () => {
  const env = makeEnv();
  await seed(env, { pv: "pv-phone", vw: 390, ev: [ev("c", 100, { el: "#phone" })] });
  await seed(env, { pv: "pv-tablet", vw: 820, ev: [ev("c", 100, { el: "#tablet" })] });
  await seed(env, { pv: "pv-desk", vw: 1440, ev: [ev("c", 100, { el: "#desk" })] });

  const sels = async (params: Record<string, string>) =>
    bySel(await points(env, { site: "testsite", path: "/", ...params })).map((p) => p.sel);

  assert.deepEqual(await sels({}), ["#desk", "#phone", "#tablet"]);
  assert.deepEqual(await sels({ vwmax: "800" }), ["#phone"]);
  assert.deepEqual(await sels({ vwmin: "800" }), ["#desk", "#tablet"]);
  assert.deepEqual(await sels({ vwmin: "400", vwmax: "1000" }), ["#tablet"]);
  // bounds are inclusive
  assert.deepEqual(await sels({ vwmin: "820", vwmax: "820" }), ["#tablet"]);
  assert.deepEqual(await sels({ vwmin: "2000" }), []);
  env.DB.close();
});

test("apiHeatmap and apiElements scope to site AND path", async () => {
  const env = makeEnv();
  await seed(env, { pv: "pv-home", site: "testsite", path: "/", ev: [ev("c", 100, { el: "#home" })] });
  await seed(env, {
    pv: "pv-pricing",
    site: "testsite",
    path: "/pricing",
    ev: [ev("c", 100, { el: "#pricing" })],
  });
  await seed(env, {
    pv: "pv-other",
    site: "othersite",
    path: "/",
    ev: [ev("c", 100, { el: "#other" })],
  });

  assert.deepEqual((await points(env, { site: "testsite", path: "/" })).map((p) => p.sel), [
    "#home",
  ]);
  assert.deepEqual((await points(env, { site: "testsite", path: "/pricing" })).map((p) => p.sel), [
    "#pricing",
  ]);
  assert.deepEqual((await points(env, { site: "othersite", path: "/" })).map((p) => p.sel), [
    "#other",
  ]);
  assert.deepEqual(await points(env, { site: "nosuchsite", path: "/" }), []);
  assert.deepEqual((await elements(env, { site: "testsite", path: "/" })).map((e) => e.sel), [
    "#home",
  ]);
  // path defaults to "/" when the param is missing
  assert.deepEqual((await points(env, { site: "testsite" })).map((p) => p.sel), ["#home"]);
  env.DB.close();
});

test("apiHeatmap excludes the viewer's own __hma elements but keeps plain underscores", async () => {
  const env = makeEnv();
  await seed(env, {
    ev: [
      ev("c", 100, { el: "#hero_cta" }),
      ev("c", 200, { el: "div.__hma-overlay" }),
      ev("c", 300, { el: "#__hmaPanel > button" }),
      ev("c", 400, { el: "canvas#x.__hma" }),
      // the LIKE pattern escapes its underscores, so two arbitrary chars
      // before "hma" must NOT be treated as a match
      ev("c", 500, { el: "#xyhma" }),
      ev("c", 600, { el: "#form_field_1" }),
    ],
  });

  assert.deepEqual(
    bySel(await points(env, { site: "testsite", path: "/" })).map((p) => p.sel),
    ["#form_field_1", "#hero_cta", "#xyhma"],
  );
  assert.deepEqual(
    bySel(await elements(env, { site: "testsite", path: "/" })).map((e) => e.sel),
    ["#form_field_1", "#hero_cta", "#xyhma"],
  );
  env.DB.close();
});

test("apiHeatmap skips events with no selector", async () => {
  const env = makeEnv();
  await seed(env, {
    ev: [ev("m", 100, { el: "#a" }), ev("m", 200, { el: null }), ev("m", 300, { el: "" })],
  });

  assert.deepEqual(await points(env, { site: "testsite", path: "/", type: "move" }), [
    { sel: "#a", rx: 0.5, ry: 0.5, n: 1 },
  ]);
  env.DB.close();
});

test("apiElements counts per selector and kind, ordered by n descending", async () => {
  const env = makeEnv();
  let seq = 0;
  const many = (n: number, k: "c" | "m" | "r" | "s", el: string) =>
    Array.from({ length: n }, () => ev(k, ++seq * 10, { el }));

  // counts deliberately cut against selector order, so only ORDER BY n DESC
  // can produce the expected sequence
  await seed(env, {
    ev: [
      ...many(5, "c", "#nav"),
      ...many(4, "c", "#buy"),
      ...many(3, "m", "#buy"),
      ...many(2, "r", "#buy"),
      ...many(1, "c", "#alpha"),
      // scroll carries no element in the tracker, but even one that did must
      // stay out of the element table — and it is the largest group here
      ...many(6, "s", "#nav"),
    ],
  });

  assert.deepEqual(await elements(env, { site: "testsite", path: "/" }), [
    { sel: "#nav", k: "c", n: 5 },
    { sel: "#buy", k: "c", n: 4 },
    { sel: "#buy", k: "m", n: 3 },
    { sel: "#buy", k: "r", n: 2 },
    { sel: "#alpha", k: "c", n: 1 },
  ]);
  env.DB.close();
});

test("apiReplay returns 404 for an unknown pageview", async () => {
  const env = makeEnv();
  await seed(env, { pv: "pv-known", ev: [ev("c", 100)] });

  for (const pv of ["pv-missing", ""]) {
    const res = await apiReplay(apiUrl("replay", { pv }), env as never);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "not found" });
  }
  env.DB.close();
});

test("apiReplay returns meta plus that pageview's events ordered by seq", async () => {
  const env = makeEnv();
  await seed(env, {
    pv: "pv-a",
    path: "/checkout",
    vw: 1280,
    vh: 720,
    sa: 1_700_000_111_000,
    d: 8200,
    msc: 73,
    // inserted out of order on purpose: only ORDER BY seq can recover 1,2,3
    ev: [
      ev("c", 300, { s: 3, el: "#third", rx: 0.3, ry: 0.31, x: 33, y: 44 }),
      ev("c", 100, { s: 1, el: "#first", rx: 0.1, ry: 0.11, x: 11, y: 22 }),
      ev("s", 200, { s: 2, y: 640 }),
    ],
  });
  await seed(env, { pv: "pv-b", path: "/checkout", ev: [ev("c", 100, { el: "#other-pv" })] });

  const res = await apiReplay(apiUrl("replay", { pv: "pv-a" }), env as never);
  assert.equal(res.status, 200);
  const { meta, events } = (await res.json()) as {
    meta: Record<string, unknown>;
    events: Record<string, unknown>[];
  };

  assert.deepEqual(Object.keys(meta).sort(), [
    "duration_ms",
    "id",
    "max_scroll",
    "path",
    "session_id",
    "site",
    "started_at",
    "vh",
    "vw",
  ]);
  assert.equal(meta.id, "pv-a");
  assert.equal(meta.site, "testsite");
  assert.equal(meta.path, "/checkout");
  assert.equal(meta.vw, 1280);
  assert.equal(meta.vh, 720);
  assert.equal(meta.started_at, 1_700_000_111_000);
  assert.equal(meta.duration_ms, 8200);
  assert.equal(meta.max_scroll, 73);
  assert.equal(meta.session_id, SID);

  assert.deepEqual(Object.keys(events[0]), ["k", "sel", "rx", "ry", "x", "y", "t"]);
  assert.deepEqual(events, [
    { k: "c", sel: "#first", rx: 0.1, ry: 0.11, x: 11, y: 22, t: 100 },
    { k: "s", sel: null, rx: null, ry: null, x: null, y: 640, t: 200 },
    { k: "c", sel: "#third", rx: 0.3, ry: 0.31, x: 33, y: 44, t: 300 },
  ]);
  env.DB.close();
});

import { expect, test, type Page } from "@playwright/test";
import { COLLECTOR, PAGES } from "../../playwright.config";
import { type ApiFixtures, mockApi, openViewer, resetBeacons, rows, status, tab } from "../helpers";

// Hardening of the owner-only overlay: everything here is driven by mocked
// read-API fixtures, because the data the viewer renders arrives from an
// unauthenticated beacon and the interesting cases are hostile or degenerate.
// The stage/cursor/ripple are matched by their inline z-index, as the other
// viewer specs do, so these assertions hold whether or not they carry ids.
const STAGE = 'div[data-hma][style*="z-index: 2147483630"]';
const CURSOR = 'div[style*="z-index: 2147483645"]';
const RIPPLE = 'div[style*="z-index: 2147483644"]';
const TIMELINE = '#__hma-panel > div[style*="border-top"]';

const stage = (page: Page) => page.locator(STAGE);
const cursor = (page: Page) => page.locator(CURSOR);
const timeline = (page: Page) => page.locator(TIMELINE);

interface Ev {
  k: string;
  sel: string | null;
  rx: number | null;
  ry: number | null;
  x: number | null;
  y: number | null;
  t: number;
}

const ev = (k: string, t: number, o: Partial<Ev> = {}): Ev => ({
  k,
  t,
  sel: null,
  rx: null,
  ry: null,
  x: null,
  y: null,
  ...o,
});

/** `n` identical events `step`ms apart — keeps a replay running long enough to
 *  observe it. step must stay under the viewer's 4s idle gap. */
const many = (k: string, n: number, step: number, o: Partial<Ev>, from = 0): Ev[] =>
  Array.from({ length: n }, (_, i) => ev(k, from + i * step, o));

const sess = (o: Record<string, unknown> = {}) => ({
  id: "pv-a",
  session_id: "s-1",
  started_at: Date.now() - 5 * 60_000,
  duration_ms: 30_000,
  vw: 1280,
  vh: 800,
  max_scroll: 50,
  clicks: 1,
  rage: 0,
  events: 8,
  pages: 1,
  ...o,
});

const jpv = (id: string, path: string) => ({
  id,
  path,
  started_at: 0,
  duration_ms: 0,
  vw: 1280,
  vh: 800,
});

async function openList(page: Page, fx: ApiFixtures, at = "/index.html"): Promise<void> {
  await page.goto(at);
  await mockApi(page, fx);
  await openViewer(page);
  await tab(page, "replay").click();
}

/** Every request URL the page (and its frames) attempted. */
function watchRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (r) => seen.push(r.url()));
  return seen;
}

/** Every URL any frame of the page navigated to. */
function watchFrames(page: Page): string[] {
  const seen: string[] = [];
  page.on("framenavigated", (f) => seen.push(f.url()));
  return seen;
}

const offOrigin = (urls: string[]) =>
  urls.filter((u) => !u.startsWith(PAGES) && !u.startsWith(COLLECTOR) && u !== "about:blank");

/** The replay iframe's own resolved location, straight out of the frame. */
async function frameLoc(page: Page) {
  return page.evaluate((s) => {
    const f = document.querySelector(`${s} iframe`) as HTMLIFrameElement | null;
    if (!f) return null;
    return {
      src: f.getAttribute("src"),
      href: f.contentWindow?.location.href ?? null,
      origin: f.contentWindow?.location.origin ?? null,
      path: f.contentWindow?.location.pathname ?? null,
    };
  }, STAGE);
}

/** Log every ripple appended to the top document (the replay's own heartbeat). */
async function watchRipples(page: Page): Promise<void> {
  await page.evaluate((sel) => {
    const log: number[] = [];
    (window as unknown as { __ripples: number[] }).__ripples = log;
    new MutationObserver((recs) => {
      for (const rec of recs) {
        for (const n of Array.from(rec.addedNodes)) {
          const el = n as HTMLElement;
          if (el.nodeType === 1 && el.matches(sel)) log.push(Date.now());
        }
      }
    }).observe(document.body, { childList: true });
  }, RIPPLE);
}

const rippleCount = (page: Page) =>
  page.evaluate(() => (window as unknown as { __ripples: number[] }).__ripples.length);

test.beforeEach(async ({ page }) => {
  await resetBeacons(page);
});

// ---------- 1. recorded paths are attacker-controlled ----------

const HOSTILE = [
  "javascript:window.top.__xss=1",
  "data:text/html,<script>window.top.__xss=1</script>",
  "//evil.example.com/x",
  "/\\evil.example.com/x",
];

const hostileFx = (withSafeLeg: boolean): ApiFixtures => {
  const pageviews = HOSTILE.map((p, i) => jpv(`pv-bad-${i}`, p));
  const events = many("m", 16, 400, { sel: "#headline", rx: 0.5, ry: 0.5, x: 40, y: 40 });
  return {
    sessions: { sessions: [sess({ id: "pv-a", pages: pageviews.length + 1, events: 16 })] },
    journey: {
      pageviews: withSafeLeg ? [jpv("pv-a", "/index.html"), ...pageviews] : [jpv("pv-a", HOSTILE[0]), ...pageviews.slice(1)],
    },
    replay: Object.fromEntries(
      ["pv-a", ...pageviews.map((p) => p.id)].map((id) => [id, { meta: { vw: 1280, vh: 800 }, events }]),
    ),
  };
};

test("a hostile recorded path is refused instead of navigating the replay iframe", async ({
  page,
}) => {
  await openList(page, hostileFx(true));
  const reqs = watchRequests(page);
  const frames = watchFrames(page);

  await rows(page).first().click();
  await expect(stage(page)).toHaveCount(1);

  // the safe leg plays; the four hostile ones are never loaded
  await expect.poll(async () => (await frameLoc(page))?.path).toBe("/index.html");
  await expect(status(page)).toHaveText(
    "Journey finished — 1 page · ⚠ 4 unsafe paths refused",
    { timeout: 25_000 },
  );

  expect(offOrigin(frames)).toEqual([]);
  expect(offOrigin(reqs)).toEqual([]);
  // a javascript: URL in an iframe runs in the opener's origin — it must never run
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  // and the refused legs are not even fetched
  const replayed = reqs
    .filter((u) => u.includes("/api/replay"))
    .map((u) => new URL(u).searchParams.get("pv"));
  expect(replayed).toEqual(["pv-a"]);
});

test("a journey of only hostile paths stages nothing and says so", async ({ page }) => {
  await openList(page, hostileFx(false));
  const reqs = watchRequests(page);
  const frames = watchFrames(page);

  await rows(page).first().click();
  await expect(status(page)).toHaveText("Refused 4 unsafe recorded paths");
  await expect(stage(page)).toHaveCount(0);
  await expect(cursor(page)).toHaveCount(0);
  await expect(timeline(page)).toHaveCount(0);
  expect(offOrigin(frames)).toEqual([]);
  expect(offOrigin(reqs)).toEqual([]);
  expect(reqs.filter((u) => u.includes("/api/replay"))).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

// ---------- 2. pv ids are attacker-controlled too ----------

test("a pv id containing selector syntax replays and cleans up", async ({ page }) => {
  const pv = 'a"]x';
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const rejected: string[] = [];
    (window as unknown as { __rejected: string[] }).__rejected = rejected;
    addEventListener("unhandledrejection", (e) => rejected.push(String(e.reason)));
  });

  await openList(page, {
    sessions: { sessions: [sess({ id: pv, events: 10 })] },
    journey: { pageviews: [jpv(pv, "/index.html")] },
    replay: {
      [pv]: {
        meta: { vw: 1280, vh: 800 },
        events: many("m", 10, 400, { sel: "#headline", rx: 0.5, ry: 0.5, x: 40, y: 40 }),
      },
    },
  });

  await expect(rows(page)).toHaveAttribute("data-pv", pv);
  await rows(page).first().click();

  // the row is highlighted, which is the lookup that used to throw
  await expect(rows(page).first()).toHaveClass(/__hma-active/);
  await expect(status(page)).toHaveText("Journey finished — 1 page", { timeout: 25_000 });
  await expect(stage(page)).toHaveCount(0);
  await expect(cursor(page)).toHaveCount(0);
  await expect(timeline(page)).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(() => (window as unknown as { __rejected: string[] }).__rejected),
  ).toEqual([]);
});

// ---------- 3. a newer replay supersedes an older one ----------

test("clicking a second row while the first is still loading leaves exactly one replay", async ({
  page,
}) => {
  const events = many("m", 40, 400, { sel: "#headline", rx: 0.5, ry: 0.5, x: 40, y: 40 });
  await page.goto("/index.html");
  await mockApi(page, {
    sessions: {
      sessions: [
        sess({ id: "pv-a", session_id: undefined, events: events.length }),
        sess({ id: "pv-b", session_id: undefined, events: events.length }),
      ],
    },
    replay: {
      "pv-a": { meta: { vw: 1280, vh: 800 }, events },
      "pv-b": { meta: { vw: 1280, vh: 800 }, events },
    },
  });
  // hold every recording fetch open, so both clicks land inside the load phase
  await page.route(`${COLLECTOR}/api/replay*`, async (route) => {
    await new Promise((r) => setTimeout(r, 500));
    await route.fallback();
  });
  await openViewer(page);
  await tab(page, "replay").click();
  await expect(rows(page)).toHaveCount(2);

  await rows(page).nth(0).click();
  await rows(page).nth(1).click();
  await page.waitForTimeout(1500); // well past both held fetches

  await expect(stage(page)).toHaveCount(1);
  await expect(cursor(page)).toHaveCount(1);
  await expect(timeline(page)).toHaveCount(1);
  // the survivor is the newer one
  await expect(page.locator(".__hma-active")).toHaveCount(1);
  await expect(rows(page).nth(1)).toHaveClass(/__hma-active/);

  await tab(page, "replay").click(); // stop
  await expect(stage(page)).toHaveCount(0);
  await expect(cursor(page)).toHaveCount(0);
  await expect(timeline(page)).toHaveCount(0);
  await expect(page.locator(".__hma-active")).toHaveCount(0);
  await expect(status(page)).toHaveText("heatmap-analytics");
});

// ---------- 4. re-injection tears the previous instance down ----------

const hmaStyles = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("style")).filter((s) =>
      (s.textContent ?? "").includes("__hma-panel"),
    ).length,
  );

test("re-injecting the viewer mid-replay leaves no orphan stage, cursor, loop or stylesheet", async ({
  page,
}) => {
  await openList(page, {
    sessions: { sessions: [sess({ id: "pv-a", events: 60 })] },
    journey: { pageviews: [jpv("pv-a", "/index.html")] },
    replay: {
      "pv-a": {
        meta: { vw: 1280, vh: 800 },
        // clicks keep ripples coming, so a surviving rAF loop is observable
        "events": [
          ...many("m", 60, 400, { sel: "#headline", rx: 0.5, ry: 0.5, x: 40, y: 40 }),
          ...many("c", 30, 800, { sel: "#lede", rx: 0.5, ry: 0.5, x: 60, y: 60 }, 200),
        ].sort((a, b) => a.t - b.t),
      },
    },
  });
  await watchRipples(page);
  expect(await hmaStyles(page)).toBe(1);

  await rows(page).first().click();
  await expect(stage(page)).toHaveCount(1);
  await expect.poll(() => rippleCount(page), { timeout: 10_000 }).toBeGreaterThan(0);

  const before = await rippleCount(page);
  await openViewer(page); // second bookmarklet click on the same page
  await page.waitForTimeout(1200);

  await expect(stage(page)).toHaveCount(0);
  await expect(cursor(page)).toHaveCount(0);
  await expect(timeline(page)).toHaveCount(0);
  await expect(page.locator("#__hma-panel")).toHaveCount(1);
  expect(await hmaStyles(page)).toBe(1);
  // the orphaned rAF loop is gone, not merely invisible
  expect(await rippleCount(page)).toBeLessThanOrEqual(before + 1);
});

// ---------- 5. scroll replay ----------

const scrollFx = (scrolls: Ev[]): ApiFixtures => ({
  sessions: { sessions: [sess({ id: "pv-a", events: 40 })] },
  journey: { pageviews: [jpv("pv-a", "/vh-scroll.html")] },
  replay: {
    "pv-a": {
      // recorded on a phone: a viewport-height ratio here would scale the
      // offset by 2, which is exactly the bug
      meta: { vw: 400, vh: 400 },
      events: [
        ...many("m", 40, 400, { sel: "#vh-scroll-title", rx: 0.5, ry: 0.5, x: 20, y: 20 }),
        ...scrolls,
      ].sort((a, b) => a.t - b.t),
    },
  },
});

/** Scroll state inside the replay iframe. */
async function frameScroll(page: Page) {
  return page.evaluate((s) => {
    const f = document.querySelector(`${s} iframe`) as HTMLIFrameElement | null;
    const w = f?.contentWindow;
    const doc = f?.contentDocument;
    if (!w || !doc) return null;
    return {
      y: Math.round(w.scrollY),
      max: Math.round(doc.documentElement.scrollHeight - f.clientHeight),
    };
  }, STAGE);
}

test("scroll replay uses the recorded document offset, not a viewport-scaled one", async ({
  page,
}) => {
  const RECORDED = 1200;
  await openList(page, scrollFx([ev("s", 600, { y: RECORDED })]));
  await rows(page).first().click();

  await expect.poll(async () => (await frameScroll(page))?.y, { timeout: 15_000 }).toBeGreaterThan(
    RECORDED - 40,
  );
  const at = (await frameScroll(page))!;
  expect(at.y).toBeLessThan(RECORDED + 40);
  // the wrongly-scaled offset (2400) is reachable in this document, so landing
  // near 1200 is a real distinction and not the browser clamping for us
  expect(at.max).toBeGreaterThan(RECORDED * 2 + 500);
  // proportionally near the recorded depth, in a document that can hold it
  expect(at.y / at.max).toBeLessThan(0.35);
});

test("a scroll offset past the end of the current document clamps to its range", async ({
  page,
}) => {
  await openList(page, scrollFx([ev("s", 600, { y: 99_999 })]));
  await rows(page).first().click();

  await expect.poll(async () => (await frameScroll(page))?.y, { timeout: 15_000 }).toBeGreaterThan(
    0,
  );
  const at = (await frameScroll(page))!;
  expect(at.y).toBeLessThanOrEqual(at.max);
  expect(at.y).toBeGreaterThan(at.max - 5); // pinned to the bottom, not beyond it
});

// ---------- 6. heat lands on the element on a positioned body ----------

/** Strongest alpha the canvas holds where `sel` actually is on screen. */
async function heatOnElement(page: Page, sel: string) {
  return page.evaluate((sel) => {
    const c = document.getElementById("__hma-canvas") as HTMLCanvasElement | null;
    const el = document.querySelector(sel);
    if (!c || !el) return null;
    const cr = c.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const x = Math.round(er.left + er.width / 2 - cr.left);
    const y = Math.round(er.top + er.height / 2 - cr.top);
    const x0 = Math.max(0, x - 2);
    const y0 = Math.max(0, y - 2);
    let max = 0;
    if (x0 < c.width && y0 < c.height) {
      const d = c.getContext("2d")!.getImageData(x0, y0, 5, 5).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > max) max = d[i];
    }
    return { max, x, y, originX: cr.left + scrollX, originY: cr.top + scrollY };
  }, sel);
}

test("heat lands on its element even when the body is positioned, centred and margined", async ({
  page,
}) => {
  await page.goto("/vh-offset-body.html");
  // the body is 900px wide inside a 1280px viewport, so it is inset ~190px
  const inset = await page.evaluate(() => document.body.getBoundingClientRect().left);
  expect(inset).toBeGreaterThan(100);

  await mockApi(page, {
    heatmap: { click: { points: [{ sel: "#vh-target", rx: 0.5, ry: 0.5, n: 12 }] } },
  });
  await openViewer(page);
  await tab(page, "click").click();
  await expect(status(page)).toHaveText("12 clicks");

  const hit = (await heatOnElement(page, "#vh-target"))!;
  expect(hit.max).toBeGreaterThan(150); // the blob is where the button is
  expect(Math.abs(hit.originX)).toBeLessThan(1); // canvas sits at the document origin
  expect(Math.abs(hit.originY)).toBeLessThan(1);

  const clear = (await heatOnElement(page, "#vh-second-title"))!;
  expect(clear.max).toBe(0);
});

// ---------- 7. synthesized clicks: each guard on its own ----------

test("replayed clicks honour the opt-in inside a form and never navigate or submit", async ({
  page,
}) => {
  const hit = (sel: string, t: number) => ev("c", t, { sel, rx: 0.5, ry: 0.5, x: 30, y: 30 });
  await openList(
    page,
    {
      sessions: { sessions: [sess({ id: "pv-a", events: 20 })] },
      journey: { pageviews: [jpv("pv-a", "/vh-synth.html")] },
      replay: {
        "pv-a": {
          meta: { vw: 1280, vh: 800 },
          events: [
            hit("#vh-free", 500), // plain button, no form, no link
            hit("#vh-in-link", 1000), // (a) button-ish inside a link
            hit("#vh-plain", 1500), // (b) non-submit button inside a form
            hit("#vh-optin", 2000), // (c) opted-in control inside a form
            hit("#vh-implicit", 2500), // <button> with no type = submit
            hit("#vh-static", 3000), // opted out
            ...many("m", 12, 400, { sel: "#vh-heading", rx: 0.5, ry: 0.5, x: 30, y: 30 }, 3400),
          ].sort((a, b) => a.t - b.t),
        },
      },
    },
    "/vh-synth.html",
  );
  await watchRipples(page);
  await rows(page).first().click();

  // every recorded click ripples whether or not it is re-fired, so six ripples
  // means all six have been played — assert while the stage is still up
  await expect.poll(() => rippleCount(page), { timeout: 20_000 }).toBe(6);

  const inFrame = await page.evaluate((s) => {
    const f = document.querySelector(`${s} iframe`) as HTMLIFrameElement | null;
    const w = f?.contentWindow as unknown as { __fired: string[] } | undefined;
    const doc = f?.contentDocument;
    return {
      fired: w?.__fired ?? null,
      expanded: doc?.querySelector("#vh-optin")?.getAttribute("aria-expanded") ?? null,
      path: f?.contentWindow?.location.pathname ?? null,
      search: f?.contentWindow?.location.search ?? null,
    };
  }, STAGE);

  // only the free button and the opted-in control were synthesized
  expect(inFrame.fired).toEqual(["click:vh-free", "click:vh-optin"]);
  expect(inFrame.expanded).toBe("true"); // the opt-in really did its work
  expect(inFrame.path).toBe("/vh-synth.html"); // no link followed
  expect(inFrame.search).toBe(""); // no GET form submitted
});

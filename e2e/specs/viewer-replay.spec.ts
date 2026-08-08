import { expect, test, type Page } from "@playwright/test";
import { type ApiFixtures, mockApi, openViewer, panel, resetBeacons, rows, status, tab } from "../helpers";

// Ghost-cursor session replay, driven entirely off mocked read-API fixtures so
// the recordings are exact. The cursor/ripples/stage carry no ids — the viewer
// identifies them only by inline z-index, so the specs do too.
const STAGE = 'div[data-hma][style*="z-index: 2147483630"]';
const CURSOR = 'div[style*="z-index: 2147483645"]';
const RIPPLE = 'div[style*="z-index: 2147483644"]';
const TIMELINE = '#__hma-panel > div[style*="border-top"]';

const stage = (page: Page) => page.locator(STAGE);
const cursor = (page: Page) => page.locator(CURSOR);
const ripples = (page: Page) => page.locator(RIPPLE);
const timeline = (page: Page) => page.locator(TIMELINE);

const FILL = "rgb(59, 79, 216)";
const CLICK_TICK = "rgb(249, 208, 87)";
const RAGE_TICK = "rgb(255, 45, 45)";
const ROUTE_MARK = "rgb(230, 232, 238)";

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

/** `n` identical moves `step`ms apart: holds the cursor still long enough to
 *  sample, and keeps the replay running. step must stay under the 4s idle gap. */
const moves = (n: number, step: number, o: Partial<Ev>, from = 0): Ev[] =>
  Array.from({ length: n }, (_, i) => ev("m", from + i * step, o));

const AGE_MS = 5 * 60_000; // renders as "5m ago"

const sess = (o: Record<string, unknown> = {}) => ({
  id: "pv-a",
  session_id: "s-1",
  started_at: Date.now() - AGE_MS,
  duration_ms: 30_000,
  vw: 1280,
  vh: 800,
  max_scroll: 50,
  clicks: 1,
  rage: 0,
  events: 6,
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

/** One-pageview journey of `events` recorded at `meta`. */
const single = (events: Ev[], meta = { vw: 1280, vh: 800 }, path = "/index.html"): ApiFixtures => ({
  sessions: { sessions: [sess({ events: events.length })] },
  journey: { pageviews: [jpv("pv-a", path)] },
  replay: { "pv-a": { meta, events } },
});

async function openList(page: Page, fx: ApiFixtures): Promise<void> {
  await page.goto("/index.html");
  await mockApi(page, fx);
  await openViewer(page);
  await tab(page, "replay").click();
}

/** Cursor position (from inline style, i.e. the transition target) alongside the
 *  live rect of `sel` inside the replay iframe — both in viewport coordinates,
 *  since the stage is fixed at inset 0. */
async function probe(page: Page, sel: string) {
  return page.evaluate(
    (a) => {
      const c = document.querySelector(a.cursor) as HTMLElement | null;
      const f = document.querySelector(`${a.stage} iframe`) as HTMLIFrameElement | null;
      const el = f?.contentDocument?.querySelector(a.sel) as HTMLElement | null;
      if (!c || !f || !el) return null;
      const r = el.getBoundingClientRect();
      return {
        cx: parseFloat(c.style.left),
        cy: parseFloat(c.style.top),
        left: r.left,
        top: r.top,
        w: r.width,
        h: r.height,
        fw: f.clientWidth,
        fh: f.clientHeight,
      };
    },
    { sel, cursor: CURSOR, stage: STAGE },
  );
}

async function waitAnchored(page: Page, sel: string, rx: number, ry: number) {
  await expect
    .poll(
      async () => {
        const p = await probe(page, sel);
        if (!p) return Number.MAX_SAFE_INTEGER;
        return Math.max(Math.abs(p.cx - (p.left + rx * p.w)), Math.abs(p.cy - (p.top + ry * p.h)));
      },
      { timeout: 10_000, message: `ghost cursor never landed on ${sel}` },
    )
    .toBeLessThan(2);
  const p = await probe(page, sel);
  if (!p) throw new Error("replay ended before the cursor could be sampled");
  return p;
}

async function tlInfo(page: Page) {
  return page.evaluate((sel) => {
    const tl = document.querySelector(sel) as HTMLElement | null;
    if (!tl) return null;
    const track = tl.firstElementChild as HTMLElement;
    return {
      insidePanel: tl.parentElement?.id === "__hma-panel",
      rightBeforeStatus: (tl.nextElementSibling as HTMLElement | null)?.id === "__hma-status",
      label: tl.textContent ?? "",
      fill: parseFloat((track.firstElementChild as HTMLElement).style.width),
      segs: Array.from(track.children).map((n) => {
        const d = n as HTMLElement;
        return {
          bg: d.style.background,
          left: parseFloat(d.style.left),
          width: parseFloat(d.style.width),
          title: d.title,
        };
      }),
    };
  }, TIMELINE);
}

/** Log every ripple the viewer appends to the top document, with its geometry. */
async function watchRipples(page: Page): Promise<void> {
  await page.evaluate((sel) => {
    const log: Record<string, string>[] = [];
    (window as unknown as { __ripples: Record<string, string>[] }).__ripples = log;
    new MutationObserver((recs) => {
      for (const rec of recs) {
        for (const n of Array.from(rec.addedNodes)) {
          const el = n as HTMLElement;
          if (el.nodeType === 1 && el.matches(sel)) {
            log.push({
              w: el.style.width,
              h: el.style.height,
              border: el.style.border,
              dur: el.style.animationDuration,
            });
          }
        }
      }
    }).observe(document.body, { childList: true });
  }, RIPPLE);
}

const rippleLog = (page: Page) =>
  page.evaluate(() => (window as unknown as { __ripples: Record<string, string>[] }).__ripples);

/** Path currently loaded in the replay iframe, plus a probe for one selector. */
async function framePath(page: Page, has: string) {
  return page.evaluate(
    (a) => {
      const f = document.querySelector(`${a.stage} iframe`) as HTMLIFrameElement | null;
      const doc = f?.contentDocument;
      if (!doc || !f?.contentWindow) return null;
      return { path: f.contentWindow.location.pathname, has: !!doc.querySelector(a.has) };
    },
    { stage: STAGE, has },
  );
}

test.beforeEach(async ({ page }) => {
  await resetBeacons(page);
});

test("session rows show stats, badges only when earned, and carry their pageview id", async ({
  page,
}) => {
  await openList(page, {
    sessions: {
      sessions: [
        sess({ id: "pv-a", duration_ms: 65_000, clicks: 4, rage: 0, pages: 1, max_scroll: 42, events: 12 }),
        sess({
          id: "pv-b",
          duration_ms: 30_000,
          clicks: 2,
          rage: 3,
          pages: 2,
          max_scroll: 88,
          events: 7,
          vw: 390,
          vh: 844,
        }),
        sess({ id: "pv-silent", events: 0 }), // nothing recorded → not replayable
      ],
    },
  });

  await expect(rows(page)).toHaveCount(2);
  const a = rows(page).nth(0);
  const b = rows(page).nth(1);

  await expect(a).toHaveAttribute("data-pv", "pv-a");
  await expect(b).toHaveAttribute("data-pv", "pv-b");

  await expect(a.locator(".__hma-sel")).toHaveText("⏱️ 1:05 · 🖱️ 4 · ⬇️ 42%");
  await expect(a.locator(".__hma-n")).toHaveText("5m ago");
  await expect(a).toHaveAttribute("title", "1280×800 · 12 events");
  // rage / multi-page badges are earned, not decorative
  await expect(a).not.toContainText("🔥");
  await expect(a).not.toContainText("🔀");

  await expect(b.locator(".__hma-sel")).toHaveText("⏱️ 0:30 · 🖱️ 2 · 🔥 3 · 🔀 2 pages · ⬇️ 88%");
  await expect(b).toHaveAttribute("title", "390×844 · 7 events");

  await expect(status(page)).toHaveText("2 sessions on /index.html — click one to replay");
});

test("clicking a row stages an iframe of the recorded path, a ghost cursor and an active-row mark", async ({
  page,
}) => {
  await openList(page, single(moves(20, 400, { sel: "#headline", rx: 0.5, ry: 0.5, x: 10, y: 10 })));
  await rows(page).first().click();

  await expect(stage(page)).toHaveCount(1);
  await expect(stage(page).locator("iframe")).toHaveCount(1);
  await expect(cursor(page)).toHaveCount(1);
  await expect(rows(page).first()).toHaveClass(/__hma-active/);

  await expect.poll(() => framePath(page, "#headline")).toEqual({ path: "/index.html", has: true });

  await expect(status(page)).toHaveText("Journey finished — 1 page", { timeout: 20_000 });
  await expect(stage(page)).toHaveCount(0);
  await expect(cursor(page)).toHaveCount(0);
  // the row survives the replay; only its highlight goes
  await expect(rows(page).first()).toHaveAttribute("data-pv", "pv-a");
  await expect(page.locator(".__hma-active")).toHaveCount(0);
});

test("cursor follows the recorded element, not the recorded coordinates, at any viewport", async ({
  page,
}) => {
  const meta = { vw: 400, vh: 300 }; // recorded on a phone-sized viewport
  const raw = { x: 5, y: 700 }; // and at coordinates that are wrong for this layout
  await openList(
    page,
    single(moves(40, 350, { sel: "#headline", rx: 0.9, ry: 0.5, ...raw }), meta),
  );
  await rows(page).first().click();

  const wide = await waitAnchored(page, "#headline", 0.9, 0.5);
  // 90% across a 1232px-wide headline is nowhere near the scaled raw x
  expect(Math.abs(wide.cx - raw.x * (wide.fw / meta.vw))).toBeGreaterThan(500);

  await page.setViewportSize({ width: 420, height: 620 });
  const narrow = await waitAnchored(page, "#headline", 0.9, 0.5);
  expect(narrow.w).toBeLessThan(wide.w - 500); // the headline really did reflow
  expect(Math.abs(narrow.cx - wide.cx)).toBeGreaterThan(500);
});

test("a selector that no longer resolves falls back to scaled raw coordinates", async ({ page }) => {
  const meta = { vw: 640, vh: 480 };
  const gone = { sel: "#removed-in-a-redesign", rx: 0.5, ry: 0.5, x: 120, y: 200 };
  const invalid = { sel: "div:::not-a-selector", rx: 0.5, ry: 0.5, x: 300, y: 100 };
  await openList(
    page,
    single([...moves(14, 400, gone), ...moves(14, 400, invalid, 5600)], meta),
  );
  await rows(page).first().click();

  const at = async (x: number, y: number) => {
    await expect
      .poll(
        async () => {
          const p = await probe(page, "body");
          if (!p) return Number.MAX_SAFE_INTEGER;
          return Math.max(
            Math.abs(p.cx - x * (p.fw / meta.vw)),
            Math.abs(p.cy - y * (p.fh / meta.vh)),
          );
        },
        { timeout: 10_000, message: `cursor never reached scaled (${x},${y})` },
      )
      .toBeLessThan(1);
  };

  await at(gone.x, gone.y);
  await at(invalid.x, invalid.y); // a selector that throws must not kill the replay
  await expect(status(page)).toHaveText("Journey finished — 1 page", { timeout: 20_000 });
});

test("clicks ripple and rage clicks ripple bigger and red, then clean themselves up", async ({
  page,
}) => {
  await openList(
    page,
    single([
      ev("m", 0, { sel: "#lede", rx: 0.5, ry: 0.5 }),
      ev("c", 600, { sel: "#lede", rx: 0.5, ry: 0.5 }),
      ev("r", 1800, { sel: "#lede", rx: 0.25, ry: 0.5 }),
      ...moves(8, 400, { sel: "#lede", rx: 0.5, ry: 0.5 }, 2200),
    ]),
  );
  await watchRipples(page);

  await rows(page).first().click();
  await expect(status(page)).toHaveText("Journey finished — 1 page", { timeout: 20_000 });

  expect(await rippleLog(page)).toEqual([
    { w: "36px", h: "36px", border: "3px solid rgb(249, 208, 87)", dur: "500ms" },
    { w: "56px", h: "56px", border: "4px solid rgb(255, 45, 45)", dur: "700ms" },
  ]);
  await expect(ripples(page)).toHaveCount(0);
});

test("a recorded click on a button reopens the modal, and the cursor anchors inside it", async ({
  page,
}) => {
  const meta = { vw: 400, vh: 300 };
  await openList(
    page,
    single(
      [
        ...moves(8, 400, { sel: "#cta", rx: 0.5, ry: 0.5, x: 10, y: 10 }),
        ev("c", 3000, { sel: "#cta", rx: 0.5, ry: 0.5, x: 10, y: 10 }),
        // #modal-title has no box until the dialog is open, so anchoring to it
        // can only work if the recorded click was really re-fired
        ...moves(16, 400, { sel: "#modal-title", rx: 0.5, ry: 0.5, x: 10, y: 10 }, 3400),
      ],
      meta,
    ),
  );
  await rows(page).first().click();

  const modalOpen = () =>
    page.evaluate((s) => {
      const f = document.querySelector(`${s} iframe`) as HTMLIFrameElement | null;
      const d = f?.contentDocument?.querySelector("#modal") as HTMLDialogElement | null;
      return d ? d.open : null;
    }, STAGE);

  await expect.poll(modalOpen).toBe(false); // closed on load
  await expect.poll(modalOpen, { timeout: 10_000 }).toBe(true); // reopened by the replay

  const p = await waitAnchored(page, "#modal-title", 0.5, 0.5);
  expect(Math.abs(p.cx - 10 * (p.fw / meta.vw))).toBeGreaterThan(100);
});

test("links, submits and inputs are never re-fired, so the replay stays on the recorded page", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const fired: string[] = [];
    (window as unknown as { __fired: string[] }).__fired = fired;
    addEventListener(
      "click",
      (e) => fired.push(`click:${(e.target as HTMLElement).id || (e.target as HTMLElement).tagName}`),
      true,
    );
    addEventListener(
      "submit",
      (e) => {
        fired.push("submit");
        e.preventDefault();
      },
      true,
    );
  });

  const hit = (sel: string, t: number) => ev("c", t, { sel, rx: 0.5, ry: 0.5, x: 10, y: 10 });
  await openList(
    page,
    single([
      hit("#cta", 1000), // plain button → safe to reproduce
      hit("#to-blog", 2000), // link → would navigate away
      hit("#pay", 3000), // submit inside #card-form → would post
      hit("#card-number", 4000), // text input
      ...moves(14, 400, { sel: "#lede", rx: 0.5, ry: 0.5 }, 4400),
    ]),
  );
  await watchRipples(page);
  await rows(page).first().click();

  // every 'c' ripples whether or not it is re-fired, so four ripples means all
  // four recorded clicks have been played — assert while the stage still exists
  await expect.poll(async () => (await rippleLog(page)).length, { timeout: 15_000 }).toBe(4);

  const fired = await page.evaluate((s) => {
    const f = document.querySelector(`${s} iframe`) as HTMLIFrameElement | null;
    return (f?.contentWindow as unknown as { __fired: string[] })?.__fired ?? null;
  }, STAGE);
  expect(fired).toEqual(["click:cta"]);
  expect(await framePath(page, "#headline")).toEqual({ path: "/index.html", has: true });
});

test("the timeline lives in the panel above the status line and marks clicks, rage and route changes", async ({
  page,
}) => {
  await openList(page, {
    sessions: { sessions: [sess({ id: "pv-a", pages: 2, clicks: 3, rage: 1, events: 26 })] },
    journey: { pageviews: [jpv("pv-a", "/index.html"), jpv("pv-b", "/blog.html")] },
    replay: {
      "pv-a": {
        meta: { vw: 1280, vh: 800 },
        events: [
          ...moves(20, 400, { sel: "#headline", rx: 0.5, ry: 0.5 }),
          ev("c", 1000, { sel: "#lede", rx: 0.5, ry: 0.5 }),
          ev("r", 2000, { sel: "#lede", rx: 0.5, ry: 0.5 }),
          ev("c", 3000, { sel: "#lede", rx: 0.5, ry: 0.5 }),
        ].sort((a, b) => a.t - b.t),
      },
      "pv-b": {
        meta: { vw: 1280, vh: 800 },
        events: [
          ...moves(6, 400, { sel: "#blog-title", rx: 0.5, ry: 0.5 }),
          ev("c", 800, { sel: "#blog-title", rx: 0.5, ry: 0.5 }),
        ].sort((a, b) => a.t - b.t),
      },
    },
  });
  await rows(page).first().click();
  await expect(timeline(page)).toHaveCount(1);

  const tl = (await tlInfo(page))!;
  expect(tl.insidePanel).toBe(true);
  expect(tl.rightBeforeStatus).toBe(true);
  expect(tl.segs.filter((s) => s.bg === FILL)).toHaveLength(1);
  expect(tl.segs.filter((s) => s.bg === CLICK_TICK)).toHaveLength(3);
  expect(tl.segs.filter((s) => s.bg === RAGE_TICK)).toHaveLength(1);
  const routes = tl.segs.filter((s) => s.bg === ROUTE_MARK);
  expect(routes).toHaveLength(1); // one separator per route change
  expect(routes[0].title).toBe("→ /blog.html");
  // leg 1 runs 0–7600 of a 9600ms virtual total, so the separator sits ~79% in
  expect(routes[0].left).toBeCloseTo((7600 / 9600) * 100, 1);
  expect(tl.label).toContain("0:10");

  const first = (await tlInfo(page))!.fill;
  await page.waitForTimeout(700);
  const second = (await tlInfo(page))!.fill;
  expect(first).toBeGreaterThanOrEqual(0);
  expect(second).toBeGreaterThan(first);
  expect(second).toBeLessThanOrEqual(100);
});

test("a long idle gap is skipped, reported on the timeline, and finishes far faster than real time", async ({
  page,
}) => {
  await openList(
    page,
    single([
      ev("m", 500, { sel: "#headline", rx: 0.5, ry: 0.5 }),
      // 19.5s of nothing → compressed to 1s of virtual time
      ...moves(16, 400, { sel: "#lede", rx: 0.5, ry: 0.5 }, 20_000),
    ]),
  );
  const t0 = Date.now();
  await rows(page).first().click();
  await expect(timeline(page)).toHaveCount(1);

  const tl = (await tlInfo(page))!;
  const skipped = tl.segs.filter((s) => s.bg.startsWith("repeating-linear-gradient"));
  expect(skipped).toHaveLength(1);
  expect(skipped[0].title).toBe("0:20 idle skipped"); // the real gap, 19.5s
  // vEnd = 7500: the skip starts at vt 500 and occupies the 1s it was kept to
  expect(skipped[0].left).toBeCloseTo((500 / 7500) * 100, 1);
  expect(skipped[0].width).toBeCloseTo((1000 / 7500) * 100, 1);
  expect(tl.label).toContain("⏭ 0:19 idle skipped");

  await expect(status(page)).toHaveText("Journey finished — 1 page", { timeout: 20_000 });
  // the recording spans 26.4s of real time; playback must not
  expect(Date.now() - t0).toBeLessThan(9_000);
});

test("a two-page journey advances the iframe and reports the leg it is playing", async ({ page }) => {
  await openList(page, {
    sessions: { sessions: [sess({ id: "pv-a", pages: 2, events: 12 })] },
    journey: { pageviews: [jpv("pv-a", "/index.html"), jpv("pv-b", "/blog.html")] },
    replay: {
      "pv-a": { meta: { vw: 1280, vh: 800 }, events: moves(8, 400, { sel: "#headline", rx: 0.5, ry: 0.5 }) },
      "pv-b": { meta: { vw: 1280, vh: 800 }, events: moves(10, 400, { sel: "#blog-title", rx: 0.5, ry: 0.5 }) },
    },
  });
  await rows(page).first().click();

  await expect(status(page)).toContainText("[1/2] /index.html");
  await expect.poll(() => framePath(page, "#blog-title"), { timeout: 20_000 }).toEqual({
    path: "/blog.html",
    has: true,
  });
  await expect(status(page)).toContainText("[2/2] /blog.html");
  const anchored = await waitAnchored(page, "#blog-title", 0.5, 0.5);
  expect(anchored.w).toBeGreaterThan(0);

  await expect(status(page)).toHaveText("Journey finished — 2 pages", { timeout: 20_000 });
});

test("stopping a replay removes the stage, cursor, timeline and row highlight", async ({ page }) => {
  await openList(page, single(moves(40, 400, { sel: "#headline", rx: 0.5, ry: 0.5 })));

  await rows(page).first().click();
  await expect(stage(page)).toHaveCount(1);
  await expect(cursor(page)).toHaveCount(1);
  await expect(timeline(page)).toHaveCount(1);
  await expect(rows(page).first()).toHaveClass(/__hma-active/);

  await tab(page, "replay").click(); // re-clicking the mode stops it
  await expect(stage(page)).toHaveCount(0);
  await expect(cursor(page)).toHaveCount(0);
  await expect(timeline(page)).toHaveCount(0);
  await expect(page.locator(".__hma-active")).toHaveCount(0);
  await expect(status(page)).toHaveText("heatmap-analytics");

  // and the close button tears down the overlay mid-replay
  await tab(page, "replay").click();
  await rows(page).first().click();
  await expect(stage(page)).toHaveCount(1);
  await tab(page, "off").click();
  await expect(panel(page)).toHaveCount(0);
  await expect(stage(page)).toHaveCount(0);
  await expect(cursor(page)).toHaveCount(0);
  await expect(timeline(page)).toHaveCount(0);
});

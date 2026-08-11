// Replay deep links: the dashboard opens <site><path>#__hma=<ticket>, the
// tracker on that page boots the viewer with the ticket instead of the owner's
// token, and the recording plays itself. Two properties matter beyond "it
// works" — the page records nothing while the owner watches, and the ticket
// cannot reach anything but its own recording.
import { expect, test, type Page } from "@playwright/test";
import {
  TICKET,
  allEvents,
  attachTracker,
  expectBeacons,
  flush,
  mockApi,
  openTracked,
  openViewer,
  panel,
  resetBeacons,
  status,
  tab,
  watchApi,
} from "../helpers";

const STAGE = 'div[data-hma][style*="z-index: 2147483630"]';
const stage = (page: Page) => page.locator(STAGE);

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

const ON_CTA = { sel: "#cta", rx: 0.5, ry: 0.5, x: 100, y: 100 };

// short on purpose: the replay runs at 2× and every spec here waits for it to
// finish
const RECORDING = [
  ev("m", 0, ON_CTA),
  ev("m", 300, ON_CTA),
  ev("c", 600, ON_CTA),
  ev("m", 900, ON_CTA),
];

const fixtures = (path = "/index.html") => ({
  ticket: { site: "e2e", pv: "pv-a", sid: "s-1", expires_at: Date.now() + 600_000 },
  journey: { pageviews: [{ id: "pv-a", path, started_at: 0, duration_ms: 0, vw: 1280, vh: 800 }] },
  replay: { "pv-a": { meta: { vw: 1280, vh: 800 }, events: RECORDING } },
});

test("a #__hma link boots the viewer from the tracker, and that page records nothing", async ({
  page,
}) => {
  await resetBeacons(page);
  await mockApi(page, fixtures());

  await page.goto(`/index.html#__hma=${TICKET}`);
  await attachTracker(page);

  // the ticket, never the token — this page belongs to the tracked site
  await expect(page.locator(`script[src*="viewer.js?tk=${TICKET}"]`)).toHaveCount(1);
  await expect(panel(page)).toBeVisible();
  // …and it is taken out of the address bar once read, so a reload or a shared
  // URL carries no credential
  expect(new URL(page.url()).hash).toBe("");

  await page.evaluate(() => (document.querySelector("#cta") as HTMLElement).click());
  await flush(page);

  // Positive control in the same collector bucket: the identical fixture with
  // no hash records normally. Without it, "no beacons" would also pass with a
  // broken tracker, a 404 bundle or an unreachable collector.
  await openTracked(page);
  await page.locator("#broken").click();
  await flush(page);

  const beacons = await expectBeacons(page, 1);
  const events = allEvents(beacons);
  expect(events.some((e) => e.k === "c" && e.el === "#broken")).toBe(true);
  for (const e of events) expect(e.el ?? "").not.toContain("cta");
});

test("the link plays the recording it names, without anything being clicked", async ({ page }) => {
  const urls = watchApi(page);
  await mockApi(page, fixtures());
  await page.goto("/index.html");
  await openViewer(page, "e2e", { tk: TICKET });

  // no list, no row click: the ticket says what to play
  await expect(stage(page)).toBeVisible();
  await expect(tab(page, "replay")).toHaveClass(/__hma-on/);
  await expect(status(page)).toHaveText(/Journey finished — 1 page/, { timeout: 20_000 });

  // every read went out on the ticket, and the owner's token never touched
  // this page
  expect(urls.length).toBeGreaterThan(2);
  for (const url of urls) {
    expect(url).toContain(`tk=${TICKET}`);
    expect(new URL(url).searchParams.get("t")).toBeNull();
  }
  expect(urls.some((u) => u.includes("/api/ticket"))).toBe(true);
  expect(urls.some((u) => u.includes("/api/replay?"))).toBe(true);
});

test("an expired link says so rather than failing silently", async ({ page }) => {
  await mockApi(page, { ...fixtures(), expired: ["ticket"] });
  await page.goto("/index.html");
  await openViewer(page, "e2e", { tk: TICKET });

  await expect(status(page)).toHaveText(/expired/i);
  await expect(stage(page)).toHaveCount(0);
});

test("the panel keeps its other views, and says what a link cannot reach", async ({ page }) => {
  await mockApi(page, { ...fixtures(), forbidden: ["heatmap", "elements", "sessions"] });
  await page.goto("/index.html");
  await openViewer(page, "e2e", { tk: TICKET });
  await expect(status(page)).toHaveText(/Journey finished/, { timeout: 20_000 });

  // still offered — the deep link is not a different product
  for (const mode of ["click", "move", "top", "replay"]) {
    await expect(tab(page, mode)).toHaveCount(1);
  }
  await tab(page, "click").click();
  await expect(status(page)).toHaveText(/replay link opens its own recording only/i);
  await expect(page.locator("#__hma-canvas")).toHaveCount(0);
});

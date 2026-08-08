import { expect, type Frame, type Page, type Route, test } from "@playwright/test";
import { COLLECTOR, PAGES } from "../playwright.config";

export const TOKEN = "e2e-token";

/**
 * The site key beacons will carry. The tracker derives it from the page's own
 * hostname rather than accepting a data-site attribute, so this is whatever
 * host the fixtures are served from — read off PAGES so it can't drift.
 */
export const SITE = new URL(PAGES).hostname;

export interface Beacon {
  /** collector bucket the beacon landed in = the test that produced it */
  run: string;
  raw: string;
  body: {
    v: number;
    site: string;
    sid: string;
    pv: string;
    path: string;
    vw: number;
    vh: number;
    sa: number;
    d: number;
    msc: number;
    ev: { s: number; k: string; el?: string; rx?: number; ry?: number; x?: number; y?: number; t: number }[];
  } | null;
  contentType: string | null;
  origin: string | null;
  at: number;
}

/**
 * Collector URL scoped to the running test. A beacon is fire-and-forget, so
 * the pagehide flush Playwright triggers when it disposes the context can land
 * after the next test began; addressing a per-test bucket is what keeps that
 * stray out of the next test's counts (see e2e/server.mjs).
 */
export function collectorFor(): string {
  const i = test.info();
  const key = `${i.testId}-${i.repeatEachIndex}-${i.retry}`.replace(/[^A-Za-z0-9_-]/g, "");
  return `${COLLECTOR}/r/${key}`;
}

export async function resetBeacons(page: Page): Promise<void> {
  await page.request.post(`${collectorFor()}/__reset`);
}

/** Beacons produced by the current test only. */
export async function getBeacons(page: Page): Promise<Beacon[]> {
  const res = await page.request.get(`${collectorFor()}/__beacons`);
  return (await res.json()) as Beacon[];
}

/**
 * Wait until at least `n` beacons have arrived, then return that snapshot.
 * Assert on the returned array, never on a fresh read: a beacon arriving
 * between the poll and the assertion would otherwise flip the count.
 */
export async function waitForBeacons(page: Page, n = 1): Promise<Beacon[]> {
  let beacons: Beacon[] = [];
  await expect
    .poll(async () => {
      beacons = await getBeacons(page);
      return beacons.length;
    }, { timeout: 10_000, message: `expected at least ${n} beacon(s)` })
    .toBeGreaterThanOrEqual(n);
  return beacons;
}

/**
 * Wait for exactly `n` beacons and for the count to have settled, then return
 * that snapshot. Use this wherever the count itself is the assertion: it fails
 * on n+1 instead of racing a `toHaveLength(n)` on a later read.
 */
export async function expectBeacons(page: Page, n = 1): Promise<Beacon[]> {
  let settled: Beacon[] = [];
  await expect
    .poll(
      async () => {
        const first = await getBeacons(page);
        if (first.length !== n) return first.length;
        await new Promise((r) => setTimeout(r, 150));
        settled = await getBeacons(page);
        return settled.length;
      },
      { timeout: 10_000, message: `expected exactly ${n} beacon(s)` },
    )
    .toBe(n);
  return settled;
}

/** All events from all beacons, flattened in arrival order. */
export function allEvents(beacons: Beacon[]) {
  return beacons.flatMap((b) => b.body?.ev ?? []);
}

export function kinds(beacons: Beacon[]): string {
  return allEvents(beacons)
    .map((e) => e.k)
    .join("");
}

/**
 * Attach the real built tracker to a page OR to a child frame. Resolves on the
 * script's load event, so a 404 fails loudly instead of looking like silence.
 */
export async function attachTracker(target: Page | Frame): Promise<void> {
  await target.evaluate(
    async ({ collector }) => {
      await new Promise<void>((resolve, reject) => {
        const s = document.createElement("script");
        s.src = `${collector}/tracker.js`;
        // no data-site: the tracker derives the key from location.hostname
        s.dataset.endpoint = collector;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error("tracker failed to load"));
        document.head.appendChild(s);
      });
    },
    { collector: collectorFor() },
  );
}

/** Load a fixture page with the real built tracker attached. */
export async function openTracked(
  page: Page,
  path = "/index.html",
  { keepWebdriver = false } = {},
): Promise<void> {
  await page.goto(keepWebdriver ? `${path}?keep-webdriver=1` : path);
  await attachTracker(page);
}

/** Flush the tracker's buffer the way a real tab-hide does. */
export async function flush(page: Page): Promise<void> {
  await page.evaluate(() => dispatchEvent(new Event("pagehide")));
}

// ---------- viewer helpers ----------

export interface ApiFixtures {
  sessions?: unknown;
  journey?: unknown;
  replay?: Record<string, unknown>;
  heatmap?: Record<string, unknown>;
  elements?: unknown;
}

/**
 * Mock the collector's read API. Keyed per endpoint; `replay` is keyed by pv
 * id, `heatmap` by type (click/move/rage).
 */
export async function mockApi(page: Page, fx: ApiFixtures): Promise<void> {
  await page.route(`${COLLECTOR}/api/**`, async (route: Route) => {
    const url = new URL(route.request().url());
    const name = url.pathname.replace("/api/", "");
    const json = (data: unknown) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify(data),
      });

    if (name === "sessions") return json(fx.sessions ?? { sessions: [] });
    if (name === "journey") return json(fx.journey ?? { pageviews: [] });
    if (name === "elements") return json(fx.elements ?? { elements: [] });
    if (name === "heatmap") {
      const type = url.searchParams.get("type") ?? "click";
      return json(fx.heatmap?.[type] ?? { points: [] });
    }
    if (name === "replay") {
      const pv = url.searchParams.get("pv") ?? "";
      return json(fx.replay?.[pv] ?? { meta: { vw: 1280, vh: 800 }, events: [] });
    }
    return route.fulfill({ status: 404, body: "{}" });
  });
}

/** Inject the real built viewer overlay. */
export async function openViewer(page: Page, site = "e2e"): Promise<void> {
  await page.evaluate(
    async ({ collector, site, token }) => {
      await new Promise<void>((resolve, reject) => {
        const s = document.createElement("script");
        s.src = `${collector}/viewer.js?t=${token}&site=${site}`;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error("viewer failed to load"));
        document.body.appendChild(s);
      });
    },
    { collector: COLLECTOR, site, token: TOKEN },
  );
  await expect(page.locator("#__hma-panel")).toBeVisible();
}

export const panel = (page: Page) => page.locator("#__hma-panel");
export const status = (page: Page) => page.locator("#__hma-status");
export const rows = (page: Page) => page.locator("#__hma-body .__hma-row");
export const tab = (page: Page, mode: string) =>
  page.locator(`#__hma-panel button[data-mode="${mode}"]`);

// The dashboard: every visit on every connected site, filtered by date and by
// path, minus the visitors the owner is hiding — and one click to replay any of
// them on the page it was recorded on. Driven off mocked reads, so what is
// under test is the page: what it sends, what it draws, and what it opens.
import { expect, test, type Page } from "@playwright/test";
import {
  DASHBOARD,
  TICKET,
  TOKEN,
  openDashboard,
  opened,
  visits,
  watchApi,
} from "../helpers";

const NOW = Date.now();
const MIN = 60_000;

const leg = (id: string, path: string, o: Record<string, unknown> = {}) => ({
  id,
  site: "one.example",
  session_id: "s-1",
  path,
  started_at: NOW - 5 * MIN,
  duration_ms: 20_000,
  active_ms: 12_000,
  active_estimated: 0,
  clicks: 2,
  rage: 0,
  events: 20,
  max_scroll: 60,
  vw: 1280,
  vh: 800,
  ...o,
});

const visit = (o: Record<string, unknown> = {}) => ({
  episode: "pv-a",
  site: "one.example",
  session_id: "s-1",
  started_at: NOW - 5 * MIN,
  ended_at: NOW - 4 * MIN,
  entry_path: "/pricing",
  pages: 1,
  duration_ms: 60_000,
  active_ms: 12_000,
  active_estimated: 0,
  clicks: 2,
  rage: 1,
  events: 20,
  max_scroll: 60,
  legs: [leg("pv-a", "/pricing")],
  ...o,
});

const OTHER = visit({
  episode: "pv-b",
  site: "two.example",
  session_id: "s-2",
  entry_path: "/",
  started_at: NOW - 90 * MIN,
  ended_at: NOW - 88 * MIN,
  pages: 2,
  clicks: 5,
  rage: 0,
  legs: [
    leg("pv-b", "/", { site: "two.example", session_id: "s-2" }),
    leg("pv-c", "/docs", { site: "two.example", session_id: "s-2" }),
  ],
});

const FX = {
  sites: {
    sites: [
      { site: "one.example", pageviews: 12, visitors: 3, last_seen: NOW },
      { site: "two.example", pageviews: 4, visitors: 1, last_seen: NOW - 90 * MIN },
    ],
  },
  replays: { visits: [visit(), OTHER], total: 2, truncated: false },
  minted: { tk: TICKET, pv: "pv-a", site: "one.example", path: "/pricing" },
};

const replayCalls = (urls: string[]) => urls.filter((u) => u.includes("/api/replays"));
const param = (urls: string[], key: string) =>
  new URL(replayCalls(urls).at(-1) ?? "https://x/").searchParams.get(key);

/** A cell of the visit's own row, by column index (never the expanded legs). */
const cell = (page: Page, row: number, col: number) =>
  visits(page).nth(row).locator("tr").first().locator("td").nth(col);

test("every column has a header, and each visit fills them", async ({ page }) => {
  await openDashboard(page, FX);
  await expect(visits(page)).toHaveCount(2);

  // headers, in order — a value column with no header is a number nobody can
  // read, and a header that can disagree with its rows is how a table drifts
  await expect(page.locator("#list thead th")).toHaveText([
    "Visitor",
    "Visit",
    "Site / entry page",
    "Pages",
    "Active",
    "Clicks",
    "Rage",
    "Scroll",
    "Started",
    "",
  ]);

  await expect(cell(page, 0, 2)).toContainText("one.example");
  await expect(cell(page, 0, 2)).toContainText("/pricing");
  await expect(cell(page, 0, 3)).toHaveText("1");
  await expect(cell(page, 0, 4)).toHaveText("0:12");
  await expect(cell(page, 0, 5)).toHaveText("2");
  await expect(cell(page, 0, 6)).toHaveText("1");
  await expect(cell(page, 0, 7)).toHaveText("60%");
  await expect(cell(page, 0, 8)).toHaveText("5m ago");
  // no rage is a dash, not a zero competing with the counts beside it
  await expect(cell(page, 1, 6)).toHaveText("–");

  // the second visit spans two pages, and expands into them
  const second = visits(page).nth(1);
  await expect(cell(page, 1, 3)).toHaveText("2");
  await expect(second.locator("ul")).toHaveCount(0);
  await second.getByTitle("Show the 2 pages of this visit").click();
  await expect(second.locator("ul")).toBeVisible();
  await expect(second.locator("li")).toHaveCount(2);
  await expect(second.locator("li").nth(1)).toContainText("/docs");

  await expect(page.locator("#summary")).toContainText("2 visits");
  await expect(page.locator("#summary")).toContainText("3 pages");
  await expect(page.locator("#summary")).toContainText("2 visitors");
});

test("each row badges the visitor and the visit separately", async ({ page }) => {
  // two visits by s-1 on different days, one by s-2 between them
  await openDashboard(page, {
    ...FX,
    replays: {
      visits: [visit(), OTHER, visit({ episode: "pv-z", entry_path: "/", started_at: NOW - 300 * MIN })],
      total: 3,
      truncated: false,
    },
  });

  // shortId drops the dashes of a real UUID, so "s-1" shows as "s1"
  const visitor = (row: number) => cell(page, row, 0).locator("span");
  const which = (row: number) => cell(page, row, 1).locator("span");

  // the visitor id is the one that persists, and says how many of this
  // visitor's visits are on screen
  await expect(visitor(0)).toHaveText("s1 ×2");
  await expect(visitor(2)).toHaveText("s1 ×2");
  await expect(visitor(1)).toHaveText("s2");
  await expect(visitor(0)).toHaveAttribute("title", /visitor s-1[\s\S]*2 visits by this visitor/);
  // same visitor, same colour — the badges are interchangeable at a glance
  expect(await visitor(0).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    await visitor(2).evaluate((el) => getComputedStyle(el).backgroundColor),
  );
  expect(await visitor(1).evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(
    await visitor(0).evaluate((el) => getComputedStyle(el).backgroundColor),
  );

  // …beside it, the visit itself: two visits by one visitor are two ids
  await expect(which(0)).toHaveText("pva");
  await expect(which(2)).toHaveText("pvz");
  await expect(which(0)).toHaveAttribute("title", "visit pv-a");

  // a leg is numbered against the visit, exactly as the viewer prints it
  await visits(page).nth(1).getByTitle("Show the 2 pages of this visit").click();
  await expect(visits(page).nth(1).locator("li").nth(1).locator("span").first()).toHaveText("pvb·2");
});

test("site, date range and path search go out as query parameters", async ({ page }) => {
  const urls = watchApi(page);
  await openDashboard(page, FX);
  await expect(visits(page)).toHaveCount(2);

  const firstFrom = Number(param(urls, "from"));
  expect(param(urls, "site")).toBe("");
  expect(Number(param(urls, "to"))).toBeGreaterThan(firstFrom);

  await page.selectOption("#site", "two.example");
  await expect.poll(() => param(urls, "site")).toBe("two.example");

  await page.selectOption("#range", "30");
  await expect.poll(() => Number(param(urls, "from"))).toBeLessThan(firstFrom);

  // a date input is a *local* day, and the epoch the API gets has to say so —
  // "today" means the owner's today, not UTC's
  await page.selectOption("#range", "custom");
  await page.fill("#from", "2024-03-15");
  await page.fill("#to", "2024-03-16");
  // both bounds together: each field re-queries on its own, so the pair is
  // only settled once the second request has gone out
  await expect
    .poll(() => `${param(urls, "from")}..${param(urls, "to")}`)
    // the upper bound covers the whole of the chosen last day
    .toBe(`${new Date(2024, 2, 15).getTime()}..${new Date(2024, 2, 17).getTime()}`);

  await page.fill("#q", "pricing");
  await expect.poll(() => param(urls, "q")).toBe("pricing");
});

test("hiding a visitor filters it out of every later read, and survives a reload", async ({
  page,
}) => {
  const urls = watchApi(page);
  await openDashboard(page, FX);
  await expect(visits(page)).toHaveCount(2);
  expect(param(urls, "exclude")).toBe("");

  await visits(page).first().getByTitle("Hide this visitor from the list").click();
  await expect.poll(() => param(urls, "exclude")).toBe("s-1");
  await expect(page.locator("#hidden-toggle")).toHaveText("Hidden visitors (1)");

  // it is a view preference on this device: nothing was deleted, and the
  // next page load still applies it
  await page.reload();
  await expect(page.locator("#hidden-toggle")).toHaveText("Hidden visitors (1)");
  await expect.poll(() => param(urls, "exclude")).toBe("s-1");

  await page.click("#hidden-toggle");
  await expect(page.locator("#hidden-panel")).toContainText("s-1");
  await page.getByRole("button", { name: "Show again" }).click();
  await expect.poll(() => param(urls, "exclude")).toBe("");
  await expect(page.locator("#hidden-toggle")).toHaveText("Hidden visitors (0)");
});

test("a replay opens the recorded page with a ticket in the fragment", async ({ page }) => {
  const urls = watchApi(page);
  await openDashboard(page, FX);
  await visits(page).first().getByRole("button", { name: "▶ Replay" }).click();

  await expect
    .poll(() => opened(page))
    .toEqual([`https://one.example/pricing#__hma=${TICKET}`]);
  // the ticket is minted for the pageview the visit opened with — the leg a
  // journey replays from
  const mint = urls.find((u) => u.includes("/api/ticket"));
  expect(new URL(mint ?? "https://x/").searchParams.get("pv")).toBe("pv-a");
  await expect(page.locator("#status")).toContainText("Replay opened");
});

test("a token is asked for once and never left in the address bar", async ({ page }) => {
  await openDashboard(page, FX, { token: "" });
  await expect(page.locator("#gate")).toBeVisible();
  await expect(page.locator("#app")).toBeHidden();

  await page.fill("#gate-token", TOKEN);
  await page.getByRole("button", { name: "Open" }).click();
  await expect(page.locator("#app")).toBeVisible();
  await expect(visits(page)).toHaveCount(2);

  // …and a ?t= link hands it over exactly once
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${DASHBOARD}?t=${TOKEN}`);
  await expect(visits(page)).toHaveCount(2);
  expect(new URL(page.url()).search).toBe("");
  expect(await page.evaluate(() => localStorage.getItem("hma_dash_token"))).toBe(TOKEN);
});

test("a rejected token drops back to the gate instead of showing an empty list", async ({
  page,
}) => {
  await openDashboard(page, { ...FX, expired: ["replays", "sites"] });
  await expect(page.locator("#gate")).toBeVisible();
  await expect(page.locator("#status")).toContainText(/rejected/i);
  expect(await page.evaluate(() => localStorage.getItem("hma_dash_token"))).toBe(null);
});

test("a capped scan says so, and more visits can be loaded", async ({ page }) => {
  const urls = watchApi(page);
  await openDashboard(page, {
    ...FX,
    replays: { visits: [visit(), OTHER], total: 4, truncated: true },
  });

  await expect(page.locator("#summary")).toContainText("showing 2");
  await expect(page.locator("#summary")).toContainText("narrow it");
  await expect(page.locator("#more")).toBeVisible();

  await page.click("#more");
  await expect.poll(() => param(urls, "offset")).toBe("2");
  await expect(visits(page)).toHaveCount(4);
});

test("an empty range says so instead of showing nothing at all", async ({ page }) => {
  await openDashboard(page, { ...FX, replays: { visits: [], total: 0, truncated: false } });
  await expect(page.locator("#list")).toContainText("No visits recorded in this range");
  await expect(page.locator("#more")).toBeHidden();
});

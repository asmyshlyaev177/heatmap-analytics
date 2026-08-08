import { expect, test } from "@playwright/test";
import {
  allEvents,
  expectBeacons,
  flush,
  kinds,
  openTracked,
  resetBeacons,
  SITE,
} from "../helpers";

test.beforeEach(async ({ page }) => {
  await resetBeacons(page);
});

test("real tracker sends a cross-origin text/plain beacon with recorded events", async ({
  page,
}) => {
  await openTracked(page);
  await page.locator("#cta").hover();
  await page.locator("#broken").click();
  await flush(page);

  const beacons = await expectBeacons(page, 1);
  const b = beacons[0];
  // simple request → no preflight, and the body is a plain JSON string
  expect(b.contentType).toBe("text/plain;charset=UTF-8");
  expect(b.body?.site).toBe(SITE);
  expect(b.body?.path).toBe("/index.html");
  expect(kinds(beacons)).toMatch(/c/);
  expect(b.body?.ev.some((e) => e.el?.includes("broken"))).toBe(true);
});

test("tracker stays silent in an automated browser (webdriver guard)", async ({ page }) => {
  // The fixture only neutralises navigator.webdriver when the query says so.
  await openTracked(page, "/index.html", { keepWebdriver: true });
  expect(await page.evaluate(() => navigator.webdriver)).toBe(true);
  await page.locator("#broken").click();
  await flush(page);

  // Positive control, same fixture and same collector bucket: its beacon is
  // what makes the silence above meaningful — a 404 tracker, a broken fixture
  // or an unreachable collector would fail here instead of passing quietly.
  await openTracked(page);
  expect(await page.evaluate(() => navigator.webdriver)).toBe(false);
  await page.locator("#cta").click();
  await flush(page);

  const beacons = await expectBeacons(page, 1);
  expect(beacons[0].body!.ev.some((e) => e.k === "c" && e.el === "#cta")).toBe(true);
  // nothing from the guarded phase, which clicked #broken and nothing else
  for (const e of allEvents(beacons)) expect(e.el ?? "").not.toContain("broken");
});

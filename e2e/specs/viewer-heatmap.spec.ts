import { expect, test, type Page } from "@playwright/test";
import { COLLECTOR } from "../../playwright.config";
import { mockApi, openViewer, panel, resetBeacons, rows, status, tab, TOKEN } from "../helpers";

/** Alpha-weighted centroid of the drawn heat, in canvas (= document) pixels. */
async function heatCentroid(page: Page) {
  return page.evaluate(() => {
    const c = document.getElementById("__hma-canvas") as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    let sx = 0;
    let sy = 0;
    let lit = 0;
    for (let i = 3; i < d.length; i += 4) {
      const a = d[i];
      if (!a) continue;
      const p = (i - 3) / 4;
      const x = p % c.width;
      sum += a;
      sx += a * x;
      sy += a * ((p - x) / c.width);
      lit++;
    }
    return { x: sx / sum, y: sy / sum, lit };
  });
}

/** Strongest alpha in a box around a document-space point (0 = nothing drawn). */
async function heatAt(page: Page, x: number, y: number, r = 3) {
  return page.evaluate(
    ({ x, y, r }) => {
      const c = document.getElementById("__hma-canvas") as HTMLCanvasElement;
      const x0 = Math.max(0, Math.round(x) - r);
      const y0 = Math.max(0, Math.round(y) - r);
      const w = Math.min(c.width - x0, r * 2 + 1);
      const h = Math.min(c.height - y0, r * 2 + 1);
      if (w <= 0 || h <= 0) return -1;
      const d = c.getContext("2d")!.getImageData(x0, y0, w, h).data;
      let max = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > max) max = d[i];
      return max;
    },
    { x, y, r },
  );
}

/** Count of opaque #ff2d2d pixels in a box — the rage ring is stroked at alpha 1. */
async function rageRingPixels(page: Page, x: number, y: number, r = 20) {
  return page.evaluate(
    ({ x, y, r }) => {
      const c = document.getElementById("__hma-canvas") as HTMLCanvasElement;
      const x0 = Math.max(0, Math.round(x) - r);
      const y0 = Math.max(0, Math.round(y) - r);
      const d = c
        .getContext("2d")!
        .getImageData(x0, y0, Math.min(c.width - x0, r * 2), Math.min(c.height - y0, r * 2)).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 250 && d[i + 1] < 70 && d[i + 2] < 70 && d[i + 3] > 250) n++;
      }
      return n;
    },
    { x, y, r },
  );
}

/** Document-space centre of an element, measured independently of the viewer. */
async function docCenter(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  const scroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  return {
    x: scroll.x + box.x + box.width / 2,
    y: scroll.y + box.y + box.height / 2,
    w: box.width,
    h: box.height,
  };
}

const apiUrls = (page: Page) => {
  const seen: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/")) seen.push(r.url());
  });
  return seen;
};

const heatmapReqs = (urls: string[], type: string) =>
  urls
    .map((u) => new URL(u))
    .filter((u) => u.pathname === "/api/heatmap" && u.searchParams.get("type") === type);

test.beforeEach(async ({ page }) => {
  await resetBeacons(page);
});

test("panel is 480px wide and offers exactly the six modes", async ({ page }) => {
  await page.goto("/index.html");
  await mockApi(page, {});
  await openViewer(page);

  const box = await panel(page).boundingBox();
  expect(box?.width).toBe(480);
  await expect(status(page)).toHaveText("Ready — pick a view");

  const modes = await page
    .locator("#__hma-panel button[data-mode]")
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.mode));
  expect(modes).toEqual(["click", "move", "top", "replay", "min", "off"]);
});

test("minimize collapses the panel to a chip, the chip restores it", async ({ page }) => {
  await page.goto("/index.html");
  await mockApi(page, {});
  await openViewer(page);

  await tab(page, "min").click();
  await expect(panel(page)).toBeHidden();
  const chip = page.locator("#__hma-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText("HM");

  await chip.click();
  await expect(panel(page)).toBeVisible();
  await expect(chip).toHaveCount(0);
});

test("close removes the panel, and the chip too when minimized", async ({ page }) => {
  await page.goto("/index.html");
  await mockApi(page, {});
  await openViewer(page);

  await tab(page, "off").click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator("#__hma-chip")).toHaveCount(0);

  // second overlay, this time closed from the minimized state
  await openViewer(page);
  await tab(page, "min").click();
  await expect(page.locator("#__hma-chip")).toBeVisible();
  await tab(page, "off").dispatchEvent("click");
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator("#__hma-chip")).toHaveCount(0);
});

test("a 401 from the read API surfaces on the status line", async ({ page }) => {
  await page.goto("/index.html");
  await page.route(`${COLLECTOR}/api/**`, (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "unauthorized" }),
    }),
  );
  await openViewer(page);

  await tab(page, "click").click();
  await expect(status(page)).toHaveText("Error: heatmap: HTTP 401");
  await expect(page.locator("#__hma-canvas")).toHaveCount(0);

  await tab(page, "top").click();
  await expect(status(page)).toHaveText("Error: elements: HTTP 401");
});

test("click heatmap draws over the whole document, at the anchor element", async ({ page }) => {
  await page.goto("/index.html");
  await mockApi(page, {
    heatmap: { click: { points: [{ sel: "#cta", rx: 0.5, ry: 0.5, n: 12 }] } },
  });
  await openViewer(page);

  const urls = apiUrls(page);
  await tab(page, "click").click();
  await expect(status(page)).toHaveText("12 clicks");

  const canvas = page.locator("#__hma-canvas");
  await expect(canvas).toHaveCount(1);
  const dims = await page.evaluate(() => {
    const c = document.getElementById("__hma-canvas") as HTMLCanvasElement;
    return {
      w: c.width,
      h: c.height,
      docW: document.documentElement.clientWidth,
      docH: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
      css: [c.style.width, c.style.height],
      vh: innerHeight,
    };
  });
  expect(dims.w).toBe(dims.docW);
  expect(dims.h).toBe(dims.docH);
  expect(dims.css).toEqual([`${dims.docW}px`, `${dims.docH}px`]);
  // full-document, not viewport-sized: the fixture scrolls well past one screen
  expect(dims.h).toBeGreaterThan(dims.vh);

  const cta = await docCenter(page, "#cta");
  const heat = await heatCentroid(page);
  expect(Math.abs(heat.x - cta.x)).toBeLessThan(4);
  expect(Math.abs(heat.y - cta.y)).toBeLessThan(4);

  // heat is a local blob on the element, not a wash over the page
  expect(await heatAt(page, cta.x, cta.y)).toBeGreaterThan(150);
  const far = await docCenter(page, "#pricing-title");
  expect(await heatAt(page, far.x, far.y)).toBe(0);
  expect(await heatAt(page, cta.x, cta.y + 300)).toBe(0);

  // the query is scoped to this site + path
  const req = heatmapReqs(urls, "click")[0];
  expect(req.searchParams.get("site")).toBe("e2e");
  expect(req.searchParams.get("path")).toBe("/index.html");
  expect(req.searchParams.get("t")).toBe(TOKEN);
  expect(req.searchParams.has("vwmin")).toBe(false);
  expect(req.searchParams.has("vwmax")).toBe(false);
});

test("heat follows the element when the page reflows", async ({ page }) => {
  await page.goto("/index.html");
  await mockApi(page, {
    heatmap: { click: { points: [{ sel: "#cta", rx: 0.5, ry: 0.5, n: 7 }] } },
  });
  await openViewer(page);

  await tab(page, "click").click();
  await expect(status(page)).toHaveText("7 clicks");
  const before = await heatCentroid(page);

  // same stored point, different layout: only selector anchoring can survive this
  await page.addStyleTag({ content: "#hero{padding-top:440px}" });
  await tab(page, "click").click(); // toggles the view off
  await expect(status(page)).toHaveText("heatmap-analytics");
  await tab(page, "click").click();
  await expect(status(page)).toHaveText("7 clicks");

  const cta = await docCenter(page, "#cta");
  const after = await heatCentroid(page);
  expect(Math.abs(after.x - cta.x)).toBeLessThan(4);
  expect(Math.abs(after.y - cta.y)).toBeLessThan(4);
  expect(after.y - before.y).toBeGreaterThan(390);
  expect(after.y - before.y).toBeLessThan(410);
  expect(await heatAt(page, before.x, before.y)).toBe(0);
});

test("rage points add a count to the status and hard rings to the canvas", async ({ page }) => {
  await page.goto("/index.html");
  await mockApi(page, {
    heatmap: {
      click: { points: [{ sel: "#cta", rx: 0.5, ry: 0.5, n: 20 }] },
      rage: { points: [{ sel: "#broken", rx: 0.5, ry: 0.5, n: 7 }] },
    },
  });
  await openViewer(page);

  const urls = apiUrls(page);
  await tab(page, "click").click();
  await expect(status(page)).toHaveText("20 clicks · 🔥 7 rage");
  expect(heatmapReqs(urls, "rage")).toHaveLength(1);

  const broken = await docCenter(page, "#broken");
  expect(await rageRingPixels(page, broken.x, broken.y)).toBeGreaterThan(20);
  const cta = await docCenter(page, "#cta");
  // rage counts are markers only — they are not blended into the click total
  expect(await rageRingPixels(page, cta.x - 40, cta.y - 40, 12)).toBe(0);
});

test("hover view fetches moves only and spreads wider than clicks", async ({ page }) => {
  await page.goto("/index.html");
  const point = { sel: "#cta", rx: 0.5, ry: 0.5, n: 9 };
  await mockApi(page, { heatmap: { click: { points: [point] }, move: { points: [point] } } });
  await openViewer(page);

  const cta = await docCenter(page, "#cta");
  await tab(page, "click").click();
  await expect(status(page)).toHaveText("9 clicks");
  expect(await heatAt(page, cta.x + 45, cta.y, 1)).toBe(0); // click radius 16 → 32px reach

  const urls = apiUrls(page);
  await tab(page, "move").click();
  await expect(status(page)).toHaveText("9 hover samples");
  expect(await heatAt(page, cta.x + 45, cta.y, 1)).toBeGreaterThan(0); // move radius 26 → 52px
  expect(heatmapReqs(urls, "move")).toHaveLength(1);
  expect(heatmapReqs(urls, "rage")).toHaveLength(0);
});

test("device select re-requests the heatmap with viewport-width bounds", async ({ page }) => {
  await page.goto("/index.html");
  await mockApi(page, {
    heatmap: { click: { points: [{ sel: "#cta", rx: 0.5, ry: 0.5, n: 3 }] } },
  });
  await openViewer(page);

  const urls = apiUrls(page);
  await tab(page, "click").click();
  await expect(status(page)).toHaveText("3 clicks");
  const select = page.locator("#__hma-body select.__hma-dev");
  await expect(select).toHaveValue("all");

  const cases: [string, Record<string, string | null>][] = [
    ["mobile", { vwmin: null, vwmax: "767" }],
    ["tablet", { vwmin: "768", vwmax: "1023" }],
    ["desktop", { vwmin: "1024", vwmax: null }],
  ];
  for (const [value, want] of cases) {
    urls.length = 0;
    await select.selectOption(value);
    // one click refetch plus its rage overlay, no more
    await expect
      .poll(
        () => `${heatmapReqs(urls, "click").length}/${heatmapReqs(urls, "rage").length}`,
        { message: `refetch for ${value}` },
      )
      .toBe("1/1");
    for (const kind of ["click", "rage"]) {
      const q = heatmapReqs(urls, kind)[0].searchParams;
      expect(q.get("vwmin")).toBe(want.vwmin);
      expect(q.get("vwmax")).toBe(want.vwmax);
    }
  }
});

test("stale and invalid selectors are reported, the rest still renders", async ({ page }) => {
  await page.goto("/index.html");
  await mockApi(page, {
    heatmap: {
      click: {
        points: [
          { sel: "#cta", rx: 0.5, ry: 0.5, n: 5 },
          { sel: "#gone-in-a-redesign", rx: 0.5, ry: 0.5, n: 99 },
          { sel: ">>not a selector<<", rx: 0.5, ry: 0.5, n: 42 },
        ],
      },
    },
  });
  await openViewer(page);

  await tab(page, "click").click();
  // the unresolvable points contribute neither heat nor clicks
  await expect(status(page)).toHaveText("5 clicks · 2 stale selectors skipped");

  const cta = await docCenter(page, "#cta");
  expect(await heatAt(page, cta.x, cta.y)).toBeGreaterThan(150);
  const heat = await heatCentroid(page);
  expect(Math.abs(heat.x - cta.x)).toBeLessThan(4);
  expect(Math.abs(heat.y - cta.y)).toBeLessThan(4);
});

test("top elements lists counts with per-kind icons", async ({ page }) => {
  await page.goto("/index.html");
  await mockApi(page, {
    elements: {
      elements: [
        { sel: "#cta", k: "c", n: 42 },
        { sel: "#headline", k: "m", n: 17 },
        { sel: "#pay", k: "r", n: 5 },
        { sel: "#lede", k: "c", n: 1 },
      ],
    },
  });
  await openViewer(page);

  await tab(page, "top").click();
  await expect(status(page)).toHaveText("4 elements (🖱 clicks · ◦ hover · 🔥 rage)");
  await expect(rows(page)).toHaveCount(4);

  const listed = await rows(page).evaluateAll((els) =>
    els.map((e) => [
      e.querySelector(".__hma-sel")!.textContent,
      e.querySelector(".__hma-n")!.textContent,
    ]),
  );
  expect(listed).toEqual([
    ["#cta", "🖱 42"],
    ["#headline", "◦ 17"],
    ["#pay", "🔥 5"],
    ["#lede", "🖱 1"],
  ]);
  await expect(page.locator("#__hma-canvas")).toHaveCount(0);
});

test("clicking a top row scrolls to the element and outlines it", async ({ page }) => {
  await page.goto("/index.html");
  await mockApi(page, {
    elements: { elements: [{ sel: "#pricing-title", k: "c", n: 8 }] },
  });
  await openViewer(page);

  await tab(page, "top").click();
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await rows(page).first().click();

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const r = document.getElementById("pricing-title")!.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= innerHeight;
      }),
    )
    .toBe(true);
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);

  const outline = await page.evaluate(() => {
    const s = getComputedStyle(document.getElementById("pricing-title")!);
    return [s.outlineStyle, s.outlineWidth, s.outlineColor];
  });
  expect(outline).toEqual(["solid", "3px", "rgb(59, 79, 216)"]);

  // the highlight is temporary
  await expect
    .poll(
      async () =>
        page.evaluate(
          () => getComputedStyle(document.getElementById("pricing-title")!).outlineStyle,
        ),
      { timeout: 5_000 },
    )
    .toBe("none");
});

test("a top row whose element is gone says so instead of throwing", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/index.html");
  await mockApi(page, {
    elements: {
      elements: [
        { sel: "#removed-last-release", k: "c", n: 4 },
        { sel: "#cta", k: "c", n: 2 },
      ],
    },
  });
  await openViewer(page);

  await tab(page, "top").click();
  await rows(page).first().click();
  await expect(status(page)).toHaveText("Element not found on current page");

  // still functional afterwards
  await rows(page).nth(1).click();
  await expect
    .poll(async () =>
      page.evaluate(() => getComputedStyle(document.getElementById("cta")!).outlineStyle),
    )
    .toBe("solid");
  expect(errors).toEqual([]);
});

test("switching views never stacks two canvases", async ({ page }) => {
  await page.goto("/index.html");
  const point = { sel: "#cta", rx: 0.5, ry: 0.5, n: 4 };
  await mockApi(page, {
    heatmap: { click: { points: [point] }, move: { points: [point] } },
    elements: { elements: [{ sel: "#cta", k: "c", n: 4 }] },
  });
  await openViewer(page);

  await tab(page, "click").click();
  await expect(status(page)).toHaveText("4 clicks");
  await expect(page.locator("canvas")).toHaveCount(1);

  await tab(page, "move").click();
  await expect(status(page)).toHaveText("4 hover samples");
  await expect(page.locator("canvas")).toHaveCount(1);

  await tab(page, "click").click();
  await expect(status(page)).toHaveText("4 clicks");
  await expect(page.locator("canvas")).toHaveCount(1);

  await tab(page, "top").click();
  await expect(status(page)).toHaveText("1 elements (🖱 clicks · ◦ hover · 🔥 rage)");
  await expect(page.locator("canvas")).toHaveCount(0);
});

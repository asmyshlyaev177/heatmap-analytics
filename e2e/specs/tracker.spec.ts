import { expect, test, type Page } from "@playwright/test";
import {
  allEvents,
  attachTracker,
  type Beacon,
  collectorFor,
  expectBeacons,
  flush,
  getBeacons,
  kinds,
  openTracked,
  resetBeacons,
  SITE,
} from "../helpers";
// imported, not restated: the spec asserts the real contract, so a change to
// either end has to keep passing here rather than quietly matching a stale copy
import { SID_KEY, SID_RE } from "../../src/sid";
import { ENGAGEMENT_GRACE_MS } from "../../src/engagement";

const KINDS = ["c", "m", "s", "r"];
const EVENT_KEYS = ["el", "k", "rx", "ry", "s", "t", "x", "y"];
const BODY_KEYS = ["am", "d", "ev", "msc", "path", "pv", "sa", "sid", "site", "v", "vh", "vw"];

const IDLE_MS = 2500;

interface SampleCounts {
  m: number;
  s: number;
}

/**
 * Mirror the tracker's move/scroll sampling gates on the page so the helpers
 * below can wait for samples to exist instead of out-sleeping a 150ms/250ms
 * interval by a magic 50ms. Same event stream, same thresholds, same zero
 * starting point, so the counts track the tracker's to within one sample.
 */
async function installSamplerSpy(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __spy?: { m: number; s: number } };
    if (w.__spy) return;
    const c = (w.__spy = { m: 0, s: 0 });
    const gate = (ms: number, hit: () => void) => {
      let last = 0;
      return () => {
        const t = performance.now();
        if (t - last < ms) return;
        last = t;
        hit();
      };
    };
    addEventListener("pointermove", gate(150, () => c.m++), { passive: true });
    addEventListener("scroll", gate(250, () => c.s++), { passive: true });
  });
}

const samples = (page: Page): Promise<SampleCounts> =>
  page.evaluate(() => ({ ...(window as unknown as { __spy: SampleCounts }).__spy }));

/** Move the pointer until the 150ms sampler has taken `times` samples. */
async function wiggle(page: Page, times = 3): Promise<void> {
  await installSamplerSpy(page);
  const from = (await samples(page)).m;
  let i = 0;
  await expect
    .poll(
      async () => {
        await page.mouse.move(200 + ((i * 37) % 340), 240 + ((i++ * 23) % 120));
        await page.waitForTimeout(60);
        return (await samples(page)).m - from;
      },
      { timeout: 15_000, message: "sampled pointer moves" },
    )
    .toBeGreaterThanOrEqual(times);
}

/** Scroll to `y` and return once the 250ms scroll sampler has taken a sample. */
async function scrollAndSample(page: Page, y: number): Promise<void> {
  await installSamplerSpy(page);
  const from = (await samples(page)).s;
  await expect
    .poll(
      async () => {
        // two hops so every attempt really moves the scroll position (and so
        // the position we settle on is exactly y)
        await page.evaluate((to) => {
          scrollTo(0, Math.max(0, to - 3));
          scrollTo(0, to);
        }, y);
        await page.waitForTimeout(80);
        return (await samples(page)).s - from;
      },
      { timeout: 15_000, message: `scroll sample at ${y}` },
    )
    .toBeGreaterThanOrEqual(1);
}

const clicksOn = (beacons: Beacon[], sel: string) =>
  allEvents(beacons).filter((e) => e.k === "c" && e.el === sel);

test.beforeEach(async ({ page }) => {
  await resetBeacons(page);
});

test("the only device storage is one localStorage id — no cookie, no sessionStorage", async ({
  page,
}) => {
  // Spy before any page script runs: the guarantee is not just "storage ends up
  // holding one key" but that nothing else is read or written on the way there.
  await page.addInitScript(() => {
    const w = window as unknown as { __ops: string[] };
    w.__ops = [];
    const proto = Storage.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const m of ["getItem", "setItem", "removeItem", "clear", "key"]) {
      const orig = proto[m];
      proto[m] = function (this: Storage, ...a: unknown[]) {
        w.__ops.push(`${this === localStorage ? "local" : "session"}.${m}(${String(a[0])})`);
        return orig.apply(this, a);
      };
    }
    const idbOpen = indexedDB.open.bind(indexedDB);
    indexedDB.open = ((...a: [string, number?]) => {
      w.__ops.push("indexedDB.open");
      return idbOpen(...a);
    }) as typeof indexedDB.open;
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")!;
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get() {
        w.__ops.push("cookie.get");
        return (desc.get as () => string).call(document);
      },
      set(v: string) {
        w.__ops.push("cookie.set");
        (desc.set as (v: string) => void).call(document, v);
      },
    });
  });

  await openTracked(page);
  await page.locator("#cta").click();
  await wiggle(page);
  await page.locator("#modal-close").click();
  await flush(page);

  const beacons = await expectBeacons(page, 1);
  expect(kinds(beacons)).toMatch(/c/);
  expect(kinds(beacons)).toMatch(/m/);

  const probe = await page.evaluate((key) => {
    const ops = (window as unknown as { __ops: string[] }).__ops.slice();
    return {
      ops,
      cookie: document.cookie,
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
      sid: localStorage.getItem(key),
    };
  }, SID_KEY);

  // read the key, miss, write it once — and never touch anything else
  expect(probe.ops).toEqual([`local.getItem(${SID_KEY})`, `local.setItem(${SID_KEY})`]);
  expect(probe.cookie).toBe("");
  expect(probe.local).toEqual([SID_KEY]);
  expect(probe.session).toEqual([]);
  expect(probe.sid).toMatch(SID_RE);
  // the stored id is what the beacon carries, and it says nothing about the
  // device: no ua/platform/screen fragment could survive this shape
  expect(beacons[0].body!.sid).toBe(probe.sid);
});

test("the visitor id is generated once and reused across pageviews and reloads", async ({
  page,
}) => {
  await openTracked(page);
  await page.locator("#soft-nav").click(); // history.pushState('/virtual')
  await expect.poll(async () => page.url()).toContain("/virtual");
  await page.locator("#broken").click();
  await flush(page);

  const first = await expectBeacons(page, 2);
  const sid = first[0].body!.sid;
  expect(sid).toMatch(SID_RE);
  // a soft navigation opens a new pageview but stays the same visitor
  const [pv1, pv2] = first.map((b) => b.body!.pv);
  expect(pv2).not.toBe(pv1);
  expect(first[1].body!.sid).toBe(sid);

  // A full reload re-runs the tracker from scratch: it must read the id back out
  // of localStorage rather than mint a second one. Counting beacons here would
  // race the empty final flush the outgoing page fires on unload, so wait for
  // the one that belongs to the new pageview instead.
  await openTracked(page);
  await page.locator("#broken").click();
  await flush(page);

  let reloaded: Beacon | undefined;
  await expect
    .poll(
      async () => {
        const all = await getBeacons(page);
        reloaded = all.find((b) => b.body!.pv !== pv1 && b.body!.pv !== pv2);
        return !!reloaded;
      },
      { timeout: 10_000, message: "a beacon from the reloaded page" },
    )
    .toBe(true);

  expect(reloaded!.body!.path).toBe("/index.html");
  expect(reloaded!.body!.sid).toBe(sid);
  expect(await page.evaluate((k) => localStorage.getItem(k), SID_KEY)).toBe(sid);
  // and every beacon of the visit, across both page loads, carries that one id
  expect(new Set((await getBeacons(page)).map((b) => b.body!.sid))).toEqual(new Set([sid]));
});

test("a foreign or corrupted stored id is replaced instead of being sent on", async ({ page }) => {
  // The collector refuses a shape it does not recognise and substitutes a
  // throwaway id, which would silently break journey chaining — so the tracker
  // re-mints rather than forwarding whatever it finds in the key. (The full
  // table of rejected shapes is unit-tested against the same regex.)
  const junk = "not a valid id";
  await page.goto("/index.html");
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [SID_KEY, junk]);
  await attachTracker(page);
  await page.locator("#broken").click();
  await flush(page);

  const beacons = await expectBeacons(page, 1);
  const sid = beacons[0].body!.sid;
  expect(sid).toMatch(SID_RE);
  expect(sid).not.toBe(junk);
  // the replacement is persisted, so the next page load reuses it
  expect(await page.evaluate((k) => localStorage.getItem(k), SID_KEY)).toBe(sid);
});

test("a blocked localStorage does not stop the tracker", async ({ page }) => {
  // Safari private mode and some embedded webviews throw on access; the tracker
  // has to fall back to an in-memory id for the page load, not die
  await page.addInitScript(() => {
    const boom = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    Object.defineProperty(window, "localStorage", { configurable: true, get: boom });
  });

  await openTracked(page);
  await page.locator("#broken").click();
  await flush(page);

  const beacons = await expectBeacons(page, 1);
  expect(beacons[0].body!.sid).toMatch(SID_RE);
  expect(clicksOn(beacons, "#broken")).toHaveLength(1);
});

test("typed input never reaches the beacon", async ({ page }) => {
  const CARD = "4111111111111111";
  const CVV = "31X7"; // a letter in the code keeps the raw-substring check free of numeric collisions

  await openTracked(page);
  await page.locator("#card-number").click();
  await page.locator("#card-number").pressSequentially(CARD, { delay: 10 });
  await page.locator("#cvv").click();
  await page.locator("#cvv").pressSequentially(CVV, { delay: 10 });
  await page.locator("#pay").click();
  await flush(page);

  const beacons = await expectBeacons(page, 1);
  expect(await page.inputValue("#card-number")).toBe(CARD);
  expect(await page.inputValue("#cvv")).toBe(CVV);

  // the raw body does carry the fields it should, so a leaked value would show
  // up in exactly this string
  expect(beacons.map((b) => b.raw).join("")).toContain("#card-number");
  for (const b of beacons) {
    for (const needle of [CARD, CARD.slice(0, 8), CVV, CVV.toLowerCase()]) {
      expect(b.raw).not.toContain(needle);
    }
  }

  const evs = allEvents(beacons);
  expect(evs.length).toBeGreaterThan(0);
  // no keystroke channel of any kind: only the four behavioural kinds, and no
  // event field beyond the documented shape
  for (const e of evs) {
    expect(KINDS).toContain(e.k);
    for (const key of Object.keys(e)) expect(EVENT_KEYS).toContain(key);
  }
  // clicking into a field is recorded — as a click on the field, nothing else
  expect(clicksOn(beacons, "#card-number")).toHaveLength(1);
  expect(clicksOn(beacons, "#cvv")).toHaveLength(1);
  expect(clicksOn(beacons, "#pay")).toHaveLength(1);
});

test("a click is anchored to its element with normalised offsets", async ({ page }) => {
  await openTracked(page);
  const box = (await page.locator("#broken").boundingBox())!;
  await page.locator("#broken").click();
  await flush(page);

  const beacons = await expectBeacons(page, 1);
  const hits = clicksOn(beacons, "#broken");
  expect(hits).toHaveLength(1);
  const e = hits[0];
  expect(e.rx!).toBeGreaterThan(0.3);
  expect(e.rx!).toBeLessThan(0.7);
  expect(e.ry!).toBeGreaterThan(0.3);
  expect(e.ry!).toBeLessThan(0.7);
  // x/y are viewport coordinates of the same point
  expect(Math.abs(e.x! - (box.x + box.width / 2))).toBeLessThanOrEqual(2);
  expect(Math.abs(e.y! - (box.y + box.height / 2))).toBeLessThanOrEqual(2);
  // and the selector really addresses that button
  expect(await page.evaluate((s) => document.querySelector(s)?.id, e.el!)).toBe("broken");
});

test("three fast clicks on one spot fire exactly one rage event", async ({ page }) => {
  await openTracked(page);
  await page.locator("#broken").click({ clickCount: 3, delay: 20 });
  await flush(page);

  const beacons = await expectBeacons(page, 1);
  const evs = allEvents(beacons);
  const clicks = evs.filter((e) => e.k === "c" && e.el === "#broken");
  const rage = evs.filter((e) => e.k === "r");
  expect(clicks).toHaveLength(3);
  expect(rage).toHaveLength(1);
  // fired at the moment the burst reached three: right after the third click
  expect(rage[0].s).toBe(clicks[2].s + 1);
  expect(rage[0].el).toBe("#broken");
  // same click handler, two performance.now() reads — same millisecond in
  // practice, but a GC pause between them must not fail the suite; 50ms still
  // pins it to the third click rather than to any of the earlier ones (20ms
  // apart) or to the flush 100s of ms later
  expect(Math.abs(rage[0].t - clicks[2].t)).toBeLessThanOrEqual(50);
});

test("two clicks far apart in time do not count as a burst", async ({ page }) => {
  await openTracked(page);
  await page.locator("#broken").click();
  await page.waitForTimeout(1100); // > RAGE_MS, so the window has expired
  await page.locator("#broken").click();
  await page.locator("#broken").click();
  await flush(page);

  const beacons = await expectBeacons(page, 1);
  expect(allEvents(beacons).filter((e) => e.k === "r")).toHaveLength(0);
  expect(clicksOn(beacons, "#broken")).toHaveLength(3);
});

test("a soft navigation closes the pageview and opens a new one", async ({ page }) => {
  await openTracked(page);
  await page.locator("#soft-nav").click(); // history.pushState('/virtual')
  await expect.poll(async () => page.url()).toContain("/virtual");
  await page.locator("#broken").click();
  await flush(page);

  const beacons = await expectBeacons(page, 2);
  const [first, second] = beacons;
  expect(first.body!.path).toBe("/index.html");
  expect(second.body!.path).toBe("/virtual");
  expect(second.body!.pv).not.toBe(first.body!.pv);
  expect(second.body!.site).toBe(first.body!.site);

  // the pre-nav click belongs to the old pageview, the post-nav one to the new
  expect(first.body!.ev.some((e) => e.k === "c" && e.el === "#soft-nav")).toBe(true);
  expect(first.body!.ev.some((e) => e.el === "#broken")).toBe(false);
  expect(second.body!.ev.some((e) => e.k === "c" && e.el === "#broken")).toBe(true);
  // the new pageview restarts its own sequence and clock
  expect(second.body!.ev[0].s).toBe(0);
  expect(second.body!.sa).toBeGreaterThanOrEqual(first.body!.sa);
});

test("duration is last-activity time, not wall clock", async ({ page }) => {
  await openTracked(page);
  const t0 = Date.now();
  await page.locator("#broken").click();
  await wiggle(page, 2);
  const active = Date.now() - t0; // wall time consumed by the activity itself
  await page.waitForTimeout(IDLE_MS); // idle: must not extend the duration
  await flush(page);
  const wall = Date.now() - t0;

  const beacons = await expectBeacons(page, 1);
  const evs = beacons[0].body!.ev;
  const d = beacons[0].body!.d;
  expect(d).toBe(evs[evs.length - 1].t);
  expect(d).toBeGreaterThan(0);
  expect(wall).toBeGreaterThan(active + IDLE_MS - 100);
  // d is measured from the tracker's own load, a little before t0, so it can
  // exceed `active` by that offset — but never by the idle stretch, which is
  // exactly what a wall-clock duration would add.
  expect(d).toBeLessThan(active + 300);
});

// ---------- engaged time ----------
//
// `d` above is wall clock and stops at the last recorded event. `am` is the
// other half — how long the visitor was actually there — and it is measured in
// the page precisely because the two things that decide it cannot be recovered
// from the event stream afterwards: whether the tab was on screen, and whether
// a silence was a still read or an abandoned tab.

test("engaged time keeps counting after the last event, and the wall clock does not", async ({
  page,
}) => {
  await openTracked(page);
  await page.locator("#broken").click();
  await wiggle(page, 2);
  await page.waitForTimeout(IDLE_MS); // still on the page, just not touching it
  await flush(page);

  const [b] = await expectBeacons(page, 1);
  const evs = b.body!.ev;
  // the wall clock stops dead at the last thing recorded…
  expect(b.body!.d).toBe(evs[evs.length - 1].t);
  // …while the reading that followed it still counts, because the tab was up
  expect(b.body!.am).toBeGreaterThan(b.body!.d + IDLE_MS - 400);
  expect(b.body!.am).toBeLessThan(b.body!.d + IDLE_MS + 800);
});

test("a hidden tab accrues no engaged time however long it sits", async ({ page }) => {
  const HIDDEN_MS = 3000;
  await openTracked(page);
  await page.locator("#broken").click();
  await wiggle(page, 2);
  await flush(page);
  const [visible] = await expectBeacons(page, 1);

  // hide the tab the way a background tab or a switched-away window does. The
  // tracker flushes on the way out, so this beacon is the "went away" reading.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(HIDDEN_MS);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await flush(page);

  const beacons = await expectBeacons(page, 3);
  const last = beacons[beacons.length - 1].body!;
  // three seconds of wall clock passed and none of it was attention
  expect(last.am).toBeLessThan(visible.body!.am + 600);
  // and the pageview is the same one throughout — this is not a new visit
  expect(last.pv).toBe(visible.body!.pv);
});

test("engaged time stops one grace period after the last interaction", async ({ page }) => {
  // deliberately slow: the property under test is a threshold measured in real
  // seconds, and faking the clock would test the fake instead of the tracker
  test.setTimeout(90_000);
  const PAST_GRACE = ENGAGEMENT_GRACE_MS + 4000;

  await openTracked(page);
  await page.locator("#broken").click();
  const t0 = Date.now();
  await page.waitForTimeout(PAST_GRACE);
  await flush(page);

  const [b] = await expectBeacons(page, 1);
  const wall = Date.now() - t0;
  expect(wall).toBeGreaterThan(ENGAGEMENT_GRACE_MS);
  // an abandoned but still-open tab is worth one grace period, not its lifetime
  expect(b.body!.am).toBeLessThan(ENGAGEMENT_GRACE_MS + 1500);
  expect(b.body!.am).toBeGreaterThan(ENGAGEMENT_GRACE_MS - 1500);
});

test("typing keeps a page out of idle without recording a single keystroke", async ({ page }) => {
  test.setTimeout(90_000);
  const HALF = Math.round(ENGAGEMENT_GRACE_MS * 0.6);

  await openTracked(page);
  await page.locator("#card-number").click(); // the last mouse interaction there is
  await page.waitForTimeout(HALF);
  // one keystroke, well inside the grace period, re-opening it
  await page.keyboard.type("4");
  await page.waitForTimeout(HALF);
  await flush(page);

  const [b] = await expectBeacons(page, 1);
  // without the keystroke the clock would have run out one grace period after
  // the click; with it, both stretches count
  expect(b.body!.am).toBeGreaterThan(2 * HALF - 1500);

  // and it bought that by recording precisely nothing: no new event kind, no
  // new field, and no trace of the character typed
  for (const e of b.body!.ev) {
    expect(KINDS).toContain(e.k);
    for (const key of Object.keys(e)) expect(EVENT_KEYS).toContain(key);
  }
  expect(b.raw).not.toContain('"4"');
  expect(Object.keys(b.body!).sort()).toEqual(BODY_KEYS);
});

test("scrolling records scroll events and a max-scroll percentage", async ({ page }) => {
  await openTracked(page);
  const range = await page.evaluate(
    () => document.documentElement.scrollHeight - innerHeight,
  );
  expect(range).toBeGreaterThan(800);
  for (const y of [range * 0.25, range * 0.5, range * 0.75, range]) {
    await scrollAndSample(page, Math.round(y));
  }
  await flush(page);

  const beacons = await expectBeacons(page, 1);
  const scrolls = allEvents(beacons).filter((e) => e.k === "s");
  expect(scrolls.length).toBeGreaterThanOrEqual(3);
  // scroll samples are position-only: no element, no normalised offsets
  expect(scrolls[0].el).toBeUndefined();
  expect(scrolls[0].rx).toBeUndefined();
  expect(scrolls[scrolls.length - 1].y!).toBeGreaterThan(scrolls[0].y!);
  const msc = beacons[beacons.length - 1].body!.msc;
  expect(msc).toBeGreaterThan(50);
  expect(msc).toBeLessThanOrEqual(100);
});

test("elements marked [data-hma] are never recorded", async ({ page }) => {
  await openTracked(page);
  await page.evaluate(() => {
    const box = document.createElement("div");
    box.id = "hma-probe";
    box.setAttribute("data-hma", "");
    box.style.cssText =
      "position:fixed;left:24px;bottom:24px;width:240px;height:140px;background:#222;z-index:9999";
    const btn = document.createElement("button");
    btn.id = "hma-probe-btn";
    btn.textContent = "overlay";
    box.appendChild(btn);
    document.body.appendChild(box);
  });
  await page.locator("#hma-probe-btn").click();
  await page.locator("#hma-probe").click({ position: { x: 20, y: 120 } });
  await page.locator("#broken").click(); // control: the tracker is still alive
  await flush(page);

  const beacons = await expectBeacons(page, 1);
  for (const e of allEvents(beacons)) expect(e.el ?? "").not.toContain("hma-probe");
  expect(clicksOn(beacons, "#broken")).toHaveLength(1);
});

test("the tracker refuses to run inside a frame", async ({ page }) => {
  await page.goto("/tracker-frame-host.html");
  const holder = await page.waitForSelector("#hma-child");
  const frame = (await holder.contentFrame())!;
  expect(frame).toBeTruthy();
  await expect(frame.locator("#broken")).toBeVisible();

  await attachTracker(frame); // resolves on script onload → it really executed
  await frame.locator("#broken").click({ clickCount: 3, delay: 20 });
  await frame.locator("#cta").hover();
  await frame.evaluate(() => dispatchEvent(new Event("pagehide")));

  // control: the very same fixture records normally at top level, so the
  // silence in the frame is the frame guard and not an unreachable collector.
  // Waiting for the control's beacon instead of a fixed sleep is also what
  // makes the exact count below meaningful.
  await attachTracker(page);
  await page.locator("#frame-host-btn").click();
  await flush(page);

  const beacons = await expectBeacons(page, 1);
  expect(beacons[0].body!.path).toBe("/tracker-frame-host.html");
  expect(clicksOn(beacons, "#frame-host-btn")).toHaveLength(1);
  // nothing the child frame did was recorded
  for (const e of allEvents(beacons)) expect(e.el ?? "").not.toMatch(/broken|cta/);
});

test("a sendBeacon that refuses falls back to a single keepalive fetch", async ({ page }) => {
  // The only path that can re-send a batch, and the reason the collector's
  // INSERT-OR-IGNORE dedup exists — so it has to be exercised somewhere.
  await page.addInitScript(() => {
    const w = window as unknown as {
      __sb: number;
      __fetch: { url: string; method?: string; keepalive: boolean }[];
    };
    w.__sb = 0;
    w.__fetch = [];
    navigator.sendBeacon = () => {
      w.__sb++;
      return false; // e.g. over the per-origin beacon budget
    };
    const orig = window.fetch;
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      w.__fetch.push({
        url: String(input),
        method: init?.method,
        keepalive: !!init?.keepalive,
      });
      return orig(input, init);
    }) as typeof window.fetch;
  });

  await openTracked(page);
  await page.locator("#broken").click();
  await flush(page);

  const beacons = await expectBeacons(page, 1);
  const probe = await page.evaluate(() => {
    const w = window as unknown as {
      __sb: number;
      __fetch: { url: string; method?: string; keepalive: boolean }[];
    };
    return { sb: w.__sb, fetches: w.__fetch };
  });
  // sendBeacon was tried once and refused, and the retry is a keepalive POST
  expect(probe.sb).toBe(1);
  expect(probe.fetches).toEqual([
    { url: `${collectorFor()}/collect`, method: "POST", keepalive: true },
  ]);

  // ...carrying exactly the payload sendBeacon would have carried
  const b = beacons[0];
  expect(b.contentType).toBe("text/plain;charset=UTF-8");
  expect(Object.keys(b.body!).sort()).toEqual(BODY_KEYS);
  expect(b.body!.v).toBe(1);
  expect(b.body!.site).toBe(SITE);
  expect(b.body!.path).toBe("/index.html");
  expect(clicksOn(beacons, "#broken")).toHaveLength(1);
});

test("a hidden-tab flush loses nothing and later activity keeps the same pageview", async ({
  page,
}) => {
  await openTracked(page);
  await page.locator("#cta").click();
  await page.locator("#modal-close").click();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    dispatchEvent(new Event("visibilitychange"));
  });

  const first = await expectBeacons(page, 1);
  expect(first[0].body!.ev.some((e) => e.k === "c" && e.el === "#cta")).toBe(true);

  await page.evaluate(() => {
    Reflect.deleteProperty(document, "visibilityState");
  });
  expect(await page.evaluate(() => document.visibilityState)).toBe("visible");
  await page.locator("#broken").click();
  await flush(page);

  const beacons = await expectBeacons(page, 2);
  const [a, b] = beacons;
  expect(b.body!.pv).toBe(a.body!.pv);
  expect(b.body!.sa).toBe(a.body!.sa);
  expect(b.body!.ev.some((e) => e.k === "c" && e.el === "#broken")).toBe(true);
  expect(a.body!.ev.some((e) => e.el === "#broken")).toBe(false);
  // sequence numbers across both batches form one gapless run: nothing dropped
  // and nothing re-sent
  const seqs = allEvents(beacons).map((e) => e.s);
  expect(seqs.length).toBeGreaterThan(2);
  expect(seqs).toEqual(seqs.map((_, i) => i));
  expect(b.body!.d).toBeGreaterThanOrEqual(a.body!.d);
});

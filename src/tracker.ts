import { type BurstPoint, rageBurst } from "./rage";
import { SID_KEY, SID_RE } from "./sid.ts";

// Behavior tracker: clicks, sampled pointer moves, scroll. The only thing it
// stores on the device is one random visitor id in localStorage; no cookies, no
// fingerprinting, nothing else read or written. Everything batches into one
// sendBeacon per flush.
//
// Usage — the collector origin is baked in at build time and the site key is
// the page's own hostname, so the tag carries nothing at all:
//   <script async src="https://<worker>/tracker.js"></script>
//
// data-endpoint overrides the baked-in collector, which is how the e2e suite
// points each test at its own stub.
(() => {
  // Skip bots and automated browsers — also keeps Playwright/Lighthouse runs
  // from polluting the data.
  if (typeof window === "undefined" || navigator.webdriver) return;
  if ((document as { prerendering?: boolean }).prerendering) return;
  // never record inside frames — also keeps the viewer's journey-replay
  // iframe from recording phantom sessions of itself
  try {
    if (window.top !== window) return;
  } catch {
    return;
  }

  const script = document.currentScript as HTMLScriptElement | null;
  const endpoint = script?.dataset.endpoint?.replace(/\/+$/, "") || __HM_ENDPOINT__;
  // The site key is read off the page, never accepted from the tag. A key
  // passed in as markup is a key anyone can copy: paste the snippet with
  // data-site="asmyshlyaev177.dev" on some other host and its traffic lands in
  // that site's heatmaps. Deriving it from the hostname means a stray embed can
  // only ever file under its own host, where it is obvious and easy to drop.
  // (For enforcement rather than hygiene, set ALLOWED_SITES on the Worker —
  // /collect is unauthenticated, so a hand-rolled POST can still claim any key.)
  const site = location.hostname;
  if (!endpoint) return;

  const SAMPLE_MS = 150; // pointer move sampling interval
  const SCROLL_MS = 250;
  const FLUSH_MS = 20_000;
  const BATCH_SIZE = 400; // ~36KB payload, under the 64KB beacon budget
  const MAX_EVENTS = 6000; // hard cap per pageview

  const uuid = (): string =>
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  // Anonymous visitor id: random, generated once, then reused from
  // localStorage. It encodes nothing about the device or the person — it exists
  // only so the collector can group a visitor's pageviews into a journey.
  // A stored value is re-validated against the same shape the collector
  // enforces (SID_RE), because an id the collector refuses is replaced there by
  // a throwaway one and journeys would stop chaining in silence.
  // localStorage throws outright in some embedded/private contexts, so an
  // in-memory id for this page load is the fallback.
  const sid = (() => {
    try {
      const saved = localStorage.getItem(SID_KEY);
      if (saved && SID_RE.test(saved)) return saved;
      const fresh = uuid();
      localStorage.setItem(SID_KEY, fresh);
      return fresh;
    } catch {
      return uuid();
    }
  })();

  let pv = uuid();
  let t0 = performance.now();
  let startedAt = Date.now();
  let path = location.pathname;
  const now = () => Math.round(performance.now() - t0);

  interface Ev {
    s: number;
    k: "c" | "m" | "s" | "r";
    el?: string;
    rx?: number;
    ry?: number;
    x?: number;
    y?: number;
    t: number;
  }

  let buf: Ev[] = [];
  let seq = 0;
  let total = 0;
  let maxScroll = 0;
  let lastT = 0; // time of last recorded event = active duration

  const selector = (start: Element): string => {
    const parts: string[] = [];
    let el: Element | null = start;
    let depth = 0;
    while (el && depth < 6) {
      if (el.id) {
        parts.unshift(`#${CSS.escape(el.id)}`);
        break;
      }
      const tag = el.tagName.toLowerCase();
      if (tag === "body" || tag === "html") {
        parts.unshift("body");
        break;
      }
      const parent: Element | null = el.parentElement;
      let part = tag;
      if (parent) {
        const same = Array.from(parent.children).filter(
          (c) => c.tagName === el!.tagName,
        );
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(el) + 1})`;
      }
      parts.unshift(part);
      el = parent;
      depth++;
    }
    return parts.join(">");
  };

  const push = (e: Omit<Ev, "s">) => {
    if (total >= MAX_EVENTS) return;
    total++;
    lastT = e.t;
    buf.push({ s: seq++, ...e } as Ev);
    if (buf.length >= BATCH_SIZE) flush();
  };

  // never record interactions with the viewer overlay itself
  const isOwn = (t: EventTarget | null): boolean =>
    t instanceof Element && !!t.closest("[data-hma]");

  const at = (ev: MouseEvent) => {
    const el = ev.target instanceof Element ? ev.target : document.body;
    const r = el.getBoundingClientRect();
    return {
      el: selector(el),
      rx: r.width ? +((ev.clientX - r.left) / r.width).toFixed(4) : 0,
      ry: r.height ? +((ev.clientY - r.top) / r.height).toFixed(4) : 0,
      x: Math.round(ev.clientX),
      y: Math.round(ev.clientY),
    };
  };

  const flush = (final?: boolean) => {
    if (!buf.length && !final) return;
    const events = buf;
    buf = [];
    const payload = JSON.stringify({
      v: 1,
      site,
      sid,
      pv,
      path,
      vw: innerWidth,
      vh: innerHeight,
      sa: startedAt,
      d: lastT,
      msc: maxScroll,
      ev: events,
    });
    // A plain string body is text/plain — a CORS "simple request", no
    // preflight, and we never read the response.
    if (!(navigator.sendBeacon && navigator.sendBeacon(`${endpoint}/collect`, payload))) {
      fetch(`${endpoint}/collect`, {
        method: "POST",
        body: payload,
        keepalive: true,
      }).catch(() => {});
    }
  };

  let burst: BurstPoint[] = [];

  addEventListener(
    "click",
    (ev) => {
      if (isOwn(ev.target)) return;
      const pos = at(ev);
      push({ k: "c", ...pos, t: now() });
      const res = rageBurst(burst, { x: ev.clientX, y: ev.clientY, at: performance.now() });
      burst = res.burst;
      if (res.rage) push({ k: "r", ...pos, t: now() });
    },
    { capture: true, passive: true },
  );

  let lastMove = 0;
  addEventListener(
    "pointermove",
    (ev) => {
      if (isOwn(ev.target)) return;
      const t = performance.now();
      if (t - lastMove < SAMPLE_MS) return;
      lastMove = t;
      push({ k: "m", ...at(ev), t: now() });
    },
    { passive: true },
  );

  let lastScroll = 0;
  addEventListener(
    "scroll",
    () => {
      const t = performance.now();
      if (t - lastScroll < SCROLL_MS) return;
      lastScroll = t;
      const y = Math.round(scrollY);
      const range = document.documentElement.scrollHeight - innerHeight;
      if (range > 0) {
        maxScroll = Math.max(maxScroll, Math.min(100, Math.round((y / range) * 100)));
      }
      push({ k: "s", y, t: now() });
    },
    { passive: true },
  );

  // Soft navigations (Astro ClientRouter, TanStack Router, any SPA) never
  // reload the page, so without this the whole visit records as one pageview
  // stuck on the entry path. A path change closes the pageview and starts a
  // fresh one — that's what links journeys on client-side-routed sites.
  const softNav = () => {
    if (location.pathname === path) return;
    flush(true);
    pv = uuid();
    path = location.pathname;
    t0 = performance.now();
    startedAt = Date.now();
    seq = 0;
    total = 0;
    maxScroll = 0;
    lastT = 0;
    burst = [];
  };
  const hookHistory = (method: "pushState" | "replaceState") => {
    const orig = history[method].bind(history);
    history[method] = ((data: unknown, unused: string, url?: string | URL | null) => {
      orig(data, unused, url);
      softNav();
    }) as History["pushState"];
  };
  hookHistory("pushState");
  hookHistory("replaceState");
  addEventListener("popstate", softNav);

  setInterval(() => flush(), FLUSH_MS);
  addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush(true);
  });
  addEventListener("pagehide", () => flush(true));
})();

import { compressTimeline } from "./timeline";

// Owner-only overlay: heatmaps + ghost-cursor session replay, rendered on the
// live page. Loaded via bookmarklet:
//   javascript:(function(){var s=document.createElement('script');
//     s.src='https://<worker>/viewer.js?t=<TOKEN>&site=<SITE>';
//     document.body.appendChild(s)})()
(() => {
  const script = document.currentScript as HTMLScriptElement | null;
  if (!script?.src) return;
  const srcUrl = new URL(script.src);
  const endpoint = srcUrl.origin;
  const token = srcUrl.searchParams.get("t") || "";
  const site = srcUrl.searchParams.get("site") || location.hostname;

  const PREFIX = "__hma";
  // Re-injection: a previous instance may still be replaying, and this one has
  // no handle on its stage, cursor, ripples or rAF loop. Its own teardown stops
  // the loop; the sweep then removes every node the viewer owns (all carry
  // data-hma) plus its stylesheet, so nothing is left orphaned or stacked.
  const W = window as unknown as { __hmaTeardown?: () => void };
  try {
    W.__hmaTeardown?.();
  } catch {
    /* previous instance already broken — the sweep still cleans up after it */
  }
  document.querySelectorAll("[data-hma]").forEach((el) => el.remove());
  document.getElementById(`${PREFIX}-style`)?.remove();
  document.getElementById(`${PREFIX}-canvas`)?.remove(); // pre-data-hma bundles

  const api = async (path: string, params: Record<string, string> = {}) => {
    const qs = new URLSearchParams({ site, path: location.pathname, ...params, t: token });
    const res = await fetch(`${endpoint}/api/${path}?${qs}`);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  };

  // ---------- panel ----------
  const style = document.createElement("style");
  style.id = `${PREFIX}-style`;
  style.textContent = `
    #${PREFIX}-panel{position:fixed;right:16px;bottom:16px;z-index:2147483646;
      background:#16181d;color:#e6e8ee;border:1px solid #2a2e37;border-radius:10px;
      font:12px/1.5 system-ui,sans-serif;width:480px;box-shadow:0 8px 32px rgba(0,0,0,.5)}
    #${PREFIX}-panel *{box-sizing:border-box;font:inherit;color:inherit}
    .${PREFIX}-bar{display:flex;gap:4px;padding:8px;border-bottom:1px solid #2a2e37}
    .${PREFIX}-bar button{flex:1;background:#23262e;border:1px solid #2a2e37;border-radius:6px;
      padding:5px 0;cursor:pointer}
    .${PREFIX}-bar button:hover{background:#2d313b}
    .${PREFIX}-bar button.${PREFIX}-on{background:#3b4fd8;border-color:#3b4fd8}
    #${PREFIX}-body{max-height:440px;overflow:auto;padding:8px}
    #${PREFIX}-status{padding:6px 10px;color:#9aa1af;border-top:1px solid #2a2e37}
    .${PREFIX}-row{padding:6px 8px;border-radius:6px;cursor:pointer;display:flex;
      justify-content:space-between;gap:8px}
    .${PREFIX}-row:hover{background:#23262e}
    .${PREFIX}-row.${PREFIX}-active{background:#2b3670;outline:1px solid #3b4fd8}
    .${PREFIX}-row.${PREFIX}-active .${PREFIX}-n::before{content:"▶ "}
    .${PREFIX}-sel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#c5cad4}
    .${PREFIX}-n{color:#7ea2ff;flex-shrink:0}
    select.${PREFIX}-dev{width:100%;margin-bottom:8px;background:#23262e;
      border:1px solid #2a2e37;border-radius:6px;padding:4px}
    @keyframes ${PREFIX}-ripple{from{transform:scale(.3);opacity:.9}to{transform:scale(2.4);opacity:0}}
  `;
  document.head.appendChild(style);

  const panel = document.createElement("div");
  panel.id = `${PREFIX}-panel`;
  panel.dataset.hma = "1"; // the tracker skips events inside [data-hma]
  panel.innerHTML = `
    <div class="${PREFIX}-bar">
      <button data-mode="click">Clicks</button>
      <button data-mode="move">Hover</button>
      <button data-mode="top">Top</button>
      <button data-mode="replay">Replay</button>
      <button data-mode="min" title="Minimize">–</button>
      <button data-mode="off" title="Close">✕</button>
    </div>
    <div id="${PREFIX}-body"></div>
    <div id="${PREFIX}-status">heatmap-analytics</div>`;
  document.body.appendChild(panel);

  // minimize to a small chip; current view (heatmap etc.) stays on screen
  const minimize = () => {
    panel.style.display = "none";
    const chip = document.createElement("div");
    chip.id = `${PREFIX}-chip`;
    chip.dataset.hma = "1";
    chip.textContent = "HM";
    Object.assign(chip.style, {
      position: "fixed",
      right: "16px",
      bottom: "16px",
      width: "40px",
      height: "40px",
      borderRadius: "50%",
      background: "#3b4fd8",
      color: "#fff",
      font: "700 13px/40px system-ui,sans-serif",
      textAlign: "center",
      cursor: "pointer",
      zIndex: "2147483646",
      boxShadow: "0 4px 16px rgba(0,0,0,.4)",
    });
    chip.addEventListener("click", () => {
      chip.remove();
      panel.style.display = "";
    });
    document.body.appendChild(chip);
  };

  const body = panel.querySelector(`#${PREFIX}-body`) as HTMLElement;
  const status = panel.querySelector(`#${PREFIX}-status`) as HTMLElement;
  const say = (msg: string) => (status.textContent = msg);

  // ---------- heatmap rendering ----------
  let canvas: HTMLCanvasElement | null = null;
  const clearCanvas = () => {
    canvas?.remove();
    canvas = null;
  };

  const gradientLUT = (): Uint8ClampedArray => {
    const c = document.createElement("canvas");
    c.width = 1;
    c.height = 256;
    const ctx = c.getContext("2d")!;
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0.3, "#2c7bb6");
    g.addColorStop(0.5, "#00ccbc");
    g.addColorStop(0.7, "#90eb9d");
    g.addColorStop(0.85, "#f9d057");
    g.addColorStop(1, "#d7191c");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1, 256);
    return ctx.getImageData(0, 0, 1, 256).data;
  };

  interface Point {
    x: number;
    y: number;
    n: number;
  }

  const renderHeat = (points: Point[], radius: number) => {
    clearCanvas();
    const docW = document.documentElement.clientWidth;
    const docH = Math.min(
      32_000,
      Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    );
    canvas = document.createElement("canvas");
    canvas.id = `${PREFIX}-canvas`;
    canvas.dataset.hma = "1";
    canvas.width = docW;
    canvas.height = docH;
    Object.assign(canvas.style, {
      position: "absolute",
      top: "0",
      left: "0",
      width: `${docW}px`,
      height: `${docH}px`,
      pointerEvents: "none",
      zIndex: "2147483000",
    });
    document.body.appendChild(canvas);
    // Blob coordinates are document-space, so the canvas must sit exactly at
    // the document origin. top/left:0 resolves against the containing block,
    // which on a positioned, centred or margined body is not that origin — so
    // measure where the browser actually put it and correct by the difference.
    const off = canvas.getBoundingClientRect();
    const dx = off.left + scrollX;
    const dy = off.top + scrollY;
    if (dx) canvas.style.left = `${-dx}px`;
    if (dy) canvas.style.top = `${-dy}px`;
    const ctx = canvas.getContext("2d")!;

    // grayscale intensity via a soft radial template (simpleheat technique)
    const r2 = radius * 2;
    const tpl = document.createElement("canvas");
    tpl.width = tpl.height = r2 * 2;
    const tctx = tpl.getContext("2d")!;
    const grad = tctx.createRadialGradient(r2, r2, 0, r2, r2, r2);
    grad.addColorStop(0, "rgba(0,0,0,1)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    tctx.fillStyle = grad;
    tctx.fillRect(0, 0, r2 * 2, r2 * 2);

    const counts = points.map((p) => p.n).sort((a, b) => a - b);
    const max = Math.max(1, counts[Math.floor(counts.length * 0.95)] ?? 1);

    for (const p of points) {
      ctx.globalAlpha = Math.min(1, Math.max(0.06, p.n / max));
      ctx.drawImage(tpl, p.x - r2, p.y - r2);
    }

    const lut = gradientLUT();
    const img = ctx.getImageData(0, 0, docW, docH);
    const d = img.data;
    for (let i = 3; i < d.length; i += 4) {
      const a = d[i];
      if (!a) continue;
      const off = a * 4;
      d[i - 3] = lut[off];
      d[i - 2] = lut[off + 1];
      d[i - 1] = lut[off + 2];
      d[i] = Math.min(200, a + 30);
    }
    ctx.putImageData(img, 0, 0);
  };

  const resolvePoints = (
    rows: { sel: string; rx: number; ry: number; n: number }[],
  ): { points: Point[]; missed: number } => {
    const points: Point[] = [];
    let missed = 0;
    for (const row of rows) {
      let el: Element | null = null;
      try {
        el = document.querySelector(row.sel);
      } catch {
        /* stale/invalid selector */
      }
      if (!el) {
        missed++;
        continue;
      }
      const r = el.getBoundingClientRect();
      points.push({
        x: scrollX + r.left + row.rx * r.width,
        y: scrollY + r.top + row.ry * r.height,
        n: row.n,
      });
    }
    return { points, missed };
  };

  const deviceFilter = (): Record<string, string> => {
    const sel = body.querySelector(`select.${PREFIX}-dev`) as HTMLSelectElement | null;
    switch (sel?.value) {
      case "mobile":
        return { vwmax: "767" };
      case "tablet":
        return { vwmin: "768", vwmax: "1023" };
      case "desktop":
        return { vwmin: "1024" };
      default:
        return {};
    }
  };

  const devSelectHTML = `
    <select class="${PREFIX}-dev">
      <option value="all">All devices</option>
      <option value="desktop">Desktop (≥1024)</option>
      <option value="tablet">Tablet (768–1023)</option>
      <option value="mobile">Mobile (<768)</option>
    </select>`;

  // rage clicks get hard ring markers on top of the click heat, not blended in
  const drawRageMarkers = (points: Point[]) => {
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    ctx.globalAlpha = 1;
    for (const p of points) {
      ctx.strokeStyle = "#ff2d2d";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 13, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.stroke();
    }
  };

  const showHeatmap = async (type: "click" | "move") => {
    body.innerHTML = devSelectHTML;
    const run = async () => {
      say("Loading…");
      try {
        const data = await api("heatmap", { type, ...deviceFilter() });
        const { points, missed } = resolvePoints(data.points);
        renderHeat(points, type === "move" ? 26 : 16);
        const total = points.reduce((s: number, p: Point) => s + p.n, 0);
        let rageNote = "";
        if (type === "click") {
          const rage = await api("heatmap", { type: "rage", ...deviceFilter() });
          const rp = resolvePoints(rage.points).points;
          drawRageMarkers(rp);
          const rageTotal = rp.reduce((s: number, p: Point) => s + p.n, 0);
          if (rageTotal) rageNote = ` · 🔥 ${rageTotal} rage`;
        }
        say(`${total} ${type === "move" ? "hover samples" : "clicks"}${rageNote}` +
          (missed ? ` · ${missed} stale selectors skipped` : ""));
      } catch (err) {
        say(String(err));
      }
    };
    body.querySelector(`select.${PREFIX}-dev`)!.addEventListener("change", run);
    await run();
  };

  // ---------- top elements ----------
  const showTop = async () => {
    say("Loading…");
    const data = await api("elements");
    const rows = data.elements as { sel: string; k: string; n: number }[];
    body.innerHTML = rows.length ? "" : "No data yet.";
    for (const row of rows) {
      const div = document.createElement("div");
      div.className = `${PREFIX}-row`;
      const icon = row.k === "c" ? "🖱" : row.k === "r" ? "🔥" : "◦";
      div.innerHTML = `<span class="${PREFIX}-sel"></span>
        <span class="${PREFIX}-n">${icon} ${row.n}</span>`;
      (div.querySelector(`.${PREFIX}-sel`) as HTMLElement).textContent = row.sel;
      div.addEventListener("click", () => {
        try {
          const el = document.querySelector(row.sel) as HTMLElement | null;
          if (!el) return say("Element not found on current page");
          el.scrollIntoView({ block: "center", behavior: "smooth" });
          el.style.outline = "3px solid #3b4fd8";
          setTimeout(() => (el.style.outline = ""), 2000);
        } catch {
          say("Invalid selector");
        }
      });
      body.appendChild(div);
    }
    say(`${rows.length} elements (🖱 clicks · ◦ hover · 🔥 rage)`);
  };

  // ---------- replay ----------
  let replayStop: (() => void) | null = null;
  // Bumped by every new replay: a replay still in its load phase (several
  // awaited fetches, before replayStop exists) checks it and gives up, so a
  // newer replay can never end up sharing the screen with an older one.
  let replayGen = 0;
  const stopReplay = () => {
    replayStop?.(); // tears down an established replay, highlight and all
    replayGen++; // …and supersedes one that has not staged itself yet
  };

  const fmtTime = (ms: number) => {
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  const fmtAge = (ts: number) => {
    const m = Math.round((Date.now() - ts) / 60_000);
    if (m < 60) return `${m}m ago`;
    if (m < 1440) return `${Math.round(m / 60)}h ago`;
    return `${Math.round(m / 1440)}d ago`;
  };

  interface ReplayEv {
    k: string;
    sel: string | null;
    rx: number | null;
    ry: number | null;
    x: number | null;
    y: number | null;
    t: number;
  }

  interface JourneyPv {
    id: string;
    path: string;
    started_at: number;
    duration_ms: number;
    vw: number;
    vh: number;
  }

  // highlight the list row of the pageview currently being replayed. pv ids
  // arrive from an unauthenticated beacon, so they are compared as values —
  // never interpolated into a selector, which any quote or bracket would break.
  const markActive = (pvId: string | null) => {
    body.querySelectorAll(`.${PREFIX}-active`).forEach((el) =>
      el.classList.remove(`${PREFIX}-active`),
    );
    if (!pvId) return;
    for (const el of Array.from(body.querySelectorAll<HTMLElement>("[data-pv]"))) {
      if (el.dataset.pv === pvId) return el.classList.add(`${PREFIX}-active`);
    }
  };

  // Recorded paths are attacker-controlled too, and the stage iframe is
  // same-origin: only ever navigate it to a single-slash absolute path, so a
  // "javascript:", "data:" or "//host" value can never reach frame.src.
  const safePath = (p: unknown): string | null =>
    typeof p === "string" && /^\/($|[^/\\])/.test(p) && !/[\\\x00-\x1f\x7f]/.test(p) ? p : null;

  // Journey replay: plays every pageview of the visitor's session in order,
  // inside a same-origin iframe, so route changes are followed instead of the
  // replay dying at a navigation. The iframe never records itself — the
  // tracker skips framed windows.
  const playSession = async (pvId: string, sessionId?: string) => {
    const gen = ++replayGen;
    say("Loading journey…");
    let pvs: JourneyPv[] = [];
    if (sessionId) {
      try {
        pvs = (await api("journey", { sid: sessionId, pv: pvId })).pageviews;
      } catch {
        /* fall back to single-pageview replay */
      }
    }
    if (!pvs.length) {
      pvs = [{ id: pvId, path: location.pathname, started_at: 0, duration_ms: 0, vw: 0, vh: 0 }];
    }
    const startIdx = Math.max(0, pvs.findIndex((p) => p.id === pvId));
    const leg = pvs.slice(startIdx);

    // Prefetch all legs and build a compressed timebase: any gap over
    // IDLE_GAP_MS with no recorded activity plays back as IDLE_KEEP_MS, so
    // an open-but-untouched tab doesn't stall the replay. Skipped stretches
    // are marked on the timeline.
    const IDLE_GAP_MS = 4000;
    const IDLE_KEEP_MS = 1000;
    interface VEv extends ReplayEv {
      vt: number;
    }
    interface LegData {
      pv: JourneyPv;
      meta: { vw: number; vh: number };
      events: VEv[];
      vEnd: number;
      skips: { vt: number; real: number }[];
    }
    say("Loading recording…");
    const legsData: LegData[] = [];
    let refused = 0;
    for (const pv of leg) {
      if (!safePath(pv.path)) {
        refused++;
        continue;
      }
      try {
        const data = await api("replay", { pv: pv.id });
        const { events, skips, vEnd } = compressTimeline(
          data.events as ReplayEv[],
          IDLE_GAP_MS,
          IDLE_KEEP_MS,
        );
        legsData.push({ pv, meta: data.meta, events, vEnd, skips });
      } catch {
        /* leg fetch failed — skip it */
      }
    }
    const plural = (n: number) => (n > 1 ? "s" : "");
    const refusedNote = refused ? ` · ⚠ ${refused} unsafe path${plural(refused)} refused` : "";
    if (gen !== replayGen) return; // superseded while loading — never stage
    if (!legsData.length) {
      return say(
        refused
          ? `Refused ${refused} unsafe recorded path${plural(refused)}`
          : "Could not load recording",
      );
    }

    clearCanvas();

    const stage = document.createElement("div");
    stage.id = `${PREFIX}-stage`;
    stage.dataset.hma = "1";
    Object.assign(stage.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483630",
      background: "#16181d",
    });
    const frame = document.createElement("iframe");
    Object.assign(frame.style, { width: "100%", height: "100%", border: "0", display: "block" });
    stage.appendChild(frame);
    document.body.appendChild(stage);

    // video-player-style timeline: progress, click/rage ticks, route-change
    // separators, striped idle-skipped segments
    const totalV = legsData.reduce((s, l) => s + l.vEnd, 0);
    const skippedReal = legsData.reduce(
      (s, l) => s + l.skips.reduce((a, k) => a + k.real - IDLE_KEEP_MS, 0),
      0,
    );
    // lives inside the panel (above the status line) so nothing overlaps it
    const tl = document.createElement("div");
    tl.id = `${PREFIX}-timeline`;
    Object.assign(tl.style, {
      padding: "10px 12px 8px",
      borderTop: "1px solid #2a2e37",
      font: "11px/1.4 system-ui,sans-serif",
      color: "#9aa1af",
    });
    const track = document.createElement("div");
    Object.assign(track.style, {
      position: "relative",
      height: "8px",
      borderRadius: "4px",
      background: "#2a2e37",
      overflow: "hidden",
      marginBottom: "6px",
    });
    const seg = (
      left: number,
      width: number,
      css: Partial<CSSStyleDeclaration>,
      title?: string,
    ) => {
      const d = document.createElement("div");
      Object.assign(
        d.style,
        { position: "absolute", top: "0", bottom: "0" },
        css,
        { left: `${left}%`, width: `${Math.max(width, 0.35)}%` },
      );
      if (title) d.title = title;
      track.appendChild(d);
      return d;
    };
    const fill = seg(0, 0, { background: "#3b4fd8" });
    {
      let b = 0;
      for (let i = 0; i < legsData.length; i++) {
        const l = legsData[i];
        for (const k of l.skips) {
          seg(
            ((b + k.vt) / totalV) * 100,
            (IDLE_KEEP_MS / totalV) * 100,
            { background: "repeating-linear-gradient(45deg,#565d6b 0 3px,#333842 3px 6px)" },
            `${fmtTime(k.real)} idle skipped`,
          );
        }
        for (const e of l.events) {
          if (e.k === "c" || e.k === "r") {
            seg(((b + e.vt) / totalV) * 100, 0.35, {
              background: e.k === "r" ? "#ff2d2d" : "#f9d057",
            });
          }
        }
        b += l.vEnd;
        if (i < legsData.length - 1) {
          seg((b / totalV) * 100, 0.45, { background: "#e6e8ee" }, `→ ${legsData[i + 1].pv.path}`);
        }
      }
    }
    const tlLabel = document.createElement("div");
    Object.assign(tlLabel.style, { display: "flex", justifyContent: "space-between" });
    const tlLeft = document.createElement("span");
    const tlRight = document.createElement("span");
    tlRight.textContent =
      fmtTime(totalV) + (skippedReal > 0 ? ` · ⏭ ${fmtTime(skippedReal)} idle skipped` : "");
    tlLabel.append(tlLeft, tlRight);
    tl.append(track, tlLabel);
    panel.insertBefore(tl, status);

    const cursor = document.createElement("div");
    cursor.id = `${PREFIX}-cursor`;
    cursor.dataset.hma = "1";
    Object.assign(cursor.style, {
      position: "fixed",
      width: "14px",
      height: "14px",
      borderRadius: "50%",
      background: "#d7191c",
      border: "2px solid #fff",
      boxShadow: "0 0 12px rgba(215,25,28,.8)",
      zIndex: "2147483645",
      pointerEvents: "none",
      transition: "left 120ms linear, top 120ms linear",
      left: "-30px",
      top: "-30px",
    });
    document.body.appendChild(cursor);

    const speed = 2;
    let stopped = false;
    let raf = 0;
    // false once this replay is stopped or superseded by a newer one
    const live = () => !stopped && gen === replayGen;

    const cleanup = () => {
      stopped = true;
      cancelAnimationFrame(raf);
      cursor.remove();
      stage.remove();
      tl.remove();
      // a superseded replay tears down only its own nodes: the handle and the
      // row highlight belong to whichever replay is current
      if (replayStop === stop) replayStop = null;
      if (gen === replayGen) markActive(null);
    };
    const stop = () => {
      cleanup();
      say("Replay stopped");
    };
    replayStop = stop;

    const ripple = (x: number, y: number, rage = false) => {
      const size = rage ? 56 : 36;
      const r = document.createElement("div");
      r.dataset.hma = "1";
      Object.assign(r.style, {
        position: "fixed",
        left: `${x - size / 2}px`,
        top: `${y - size / 2}px`,
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: "50%",
        border: rage ? "4px solid #ff2d2d" : "3px solid #f9d057",
        zIndex: "2147483644",
        pointerEvents: "none",
        animation: `${PREFIX}-ripple ${rage ? 700 : 500}ms ease-out forwards`,
      });
      document.body.appendChild(r);
      setTimeout(() => r.remove(), 800);
    };

    const loadPage = (path: string) =>
      new Promise<void>((resolve) => {
        let done = false;
        const fin = () => {
          if (!done) {
            done = true;
            resolve();
          }
        };
        frame.addEventListener("load", fin, { once: true });
        setTimeout(fin, 10_000);
        frame.src = path;
      });

    const playEvents = (l: LegData, label: string, base: number) =>
      new Promise<void>((resolve) => {
        const events = l.events;
        const meta = l.meta;
        if (!events.length) return resolve();
        const sx = frame.clientWidth / (meta.vw || frame.clientWidth);
        const sy = frame.clientHeight / (meta.vh || frame.clientHeight);
        // Element-first positioning: resolve the recorded selector in the
        // live iframe and place the cursor at the same relative spot inside
        // that element — correct across viewport sizes and layout reflow.
        // Scaled raw coordinates are only the fallback for stale selectors.
        const locate = (e: ReplayEv): { x: number; y: number } | null => {
          if (e.sel && e.rx != null && e.ry != null) {
            try {
              const el = frame.contentDocument?.querySelector(e.sel);
              if (el) {
                const r = el.getBoundingClientRect();
                if (r.width || r.height) {
                  return { x: r.left + e.rx * r.width, y: r.top + e.ry * r.height };
                }
              }
            } catch {
              /* invalid selector — fall through */
            }
          }
          if (e.x != null && e.y != null) return { x: e.x * sx, y: e.y * sy };
          return null;
        };
        // Re-fire recorded clicks on safe UI-state controls (modal/menu/
        // accordion toggles) so the page reproduces its own state changes —
        // that's how a modal opens mid-replay without DOM recording. Two things
        // are never done: navigate (journey legs own that) and submit a form
        // (it could fire a real request).
        // Opt-out: [data-hm-static]; opt-in for custom widgets: [data-hm-replay].
        const synthClick = (e: ReplayEv) => {
          if (!e.sel) return;
          try {
            const el = frame.contentDocument?.querySelector(e.sel);
            const btn = el?.closest(
              "button, [role='button'], summary, [aria-haspopup], [aria-expanded], [data-hm-replay]",
            ) as HTMLElement | null;
            if (!btn || btn.closest("[data-hm-static]")) return;
            // a control inside a link activates the link, whatever it is
            if (btn.closest("a[href]")) return;
            // .type is "submit" for a <button> with no type attribute
            const type = (btn as Partial<HTMLButtonElement>).type as string | undefined;
            if (btn.matches("input") || type === "submit" || type === "reset") return;
            // a form ancestor vetoes everything except the documented opt-in,
            // which is how filter panels and disclosure toggles inside forms
            // get replayed; the submit veto covers a handler that submits.
            const form = btn.closest("form");
            if (form && !btn.closest("[data-hm-replay]")) return;
            const veto = (ev: Event) => ev.preventDefault();
            form?.addEventListener("submit", veto, true);
            try {
              btn.click();
            } finally {
              form?.removeEventListener("submit", veto, true);
            }
          } catch {
            /* stale selector — skip */
          }
        };
        let idx = 0;
        let elapsed = 0;
        let last = performance.now();
        const end = l.vEnd;
        const tick = (now: number) => {
          if (!live()) return resolve();
          elapsed += (now - last) * speed;
          last = now;
          while (idx < events.length && events[idx].vt <= elapsed) {
            const e = events[idx++];
            const pos = e.k === "m" || e.k === "c" || e.k === "r" ? locate(e) : null;
            if (e.k === "m" && pos) {
              cursor.style.left = `${pos.x}px`;
              cursor.style.top = `${pos.y}px`;
            } else if (e.k === "c" && pos) {
              ripple(pos.x, pos.y);
              synthClick(e);
            } else if (e.k === "r" && pos) {
              ripple(pos.x, pos.y, true);
            } else if (e.k === "s" && e.y != null) {
              try {
                // A scroll offset is document-space pixels, not a fraction of
                // the viewport, so scaling it by the viewport ratio is simply
                // wrong (a 3000px offset recorded at vh 400 is still 3000px).
                // The recorded document height is not transmitted, so the only
                // honest transform is none — replay the offset as recorded and
                // clamp it to what this document can actually scroll.
                const doc = frame.contentDocument;
                const max = Math.max(
                  0,
                  Math.max(doc?.documentElement.scrollHeight ?? 0, doc?.body.scrollHeight ?? 0) -
                    frame.clientHeight,
                );
                frame.contentWindow?.scrollTo({ top: Math.min(e.y, max) });
              } catch {
                /* cross-origin frame — skip scroll */
              }
            }
          }
          const done = Math.min(elapsed, end);
          fill.style.width = `${Math.min(100, ((base + done) / totalV) * 100)}%`;
          tlLeft.textContent = `▶ ${fmtTime(base + done)} ×${speed}`;
          say(`▶ ${label} (✕ stops)`);
          if (idx < events.length) {
            raf = requestAnimationFrame(tick);
          } else {
            resolve();
          }
        };
        raf = requestAnimationFrame(tick);
      });

    markActive(pvId);
    let base = 0;
    for (let i = 0; i < legsData.length; i++) {
      if (!live()) return cleanup();
      const l = legsData[i];
      const label = `[${i + 1}/${legsData.length}] ${l.pv.path}`;
      say(`▶ ${label} · loading…`);
      await loadPage(safePath(l.pv.path)!);
      if (!live()) return cleanup();
      await playEvents(l, label, base);
      base += l.vEnd;
      if (!live()) return cleanup();
      if (i < legsData.length - 1) {
        say(`→ ${legsData[i + 1].pv.path}`);
        await new Promise((r) => setTimeout(r, 800));
      }
    }
    if (live()) {
      cleanup();
      say(`Journey finished — ${legsData.length} page${plural(legsData.length)}${refusedNote}`);
    }
  };

  const showReplayList = async () => {
    say("Loading sessions…");
    const data = await api("sessions");
    const rows = data.sessions as {
      id: string;
      session_id: string;
      started_at: number;
      duration_ms: number;
      vw: number;
      vh: number;
      max_scroll: number;
      clicks: number;
      rage: number;
      events: number;
      pages: number;
    }[];
    const usable = rows.filter((r) => r.events > 0);
    body.innerHTML = usable.length ? "" : "No sessions recorded yet.";
    for (const row of usable) {
      const div = document.createElement("div");
      div.className = `${PREFIX}-row`;
      const rageBadge = row.rage ? ` · 🔥 ${row.rage}` : "";
      const pagesBadge = row.pages > 1 ? ` · 🔀 ${row.pages} pages` : "";
      div.dataset.pv = row.id;
      div.title = `${row.vw}×${row.vh} · ${row.events} events`;
      div.innerHTML = `<span class="${PREFIX}-sel">⏱️ ${fmtTime(row.duration_ms)} · 🖱️ ${row.clicks ?? 0}${rageBadge}${pagesBadge} · ⬇️ ${row.max_scroll}%</span>
        <span class="${PREFIX}-n">${fmtAge(row.started_at)}</span>`;
      div.addEventListener("click", () => {
        stopReplay();
        playSession(row.id, row.session_id).catch((e) => say(String(e)));
      });
      body.appendChild(div);
    }
    say(`${usable.length} sessions on ${location.pathname} — click one to replay`);
  };

  // ---------- mode switching ----------
  const buttons = Array.from(panel.querySelectorAll("button[data-mode]")) as HTMLButtonElement[];
  const reset = () => {
    clearCanvas();
    stopReplay();
    body.innerHTML = "";
    buttons.forEach((b) => b.classList.remove(`${PREFIX}-on`));
  };

  // Everything this instance owns, removable from the outside: a later
  // injection calls it so no stage, cursor, rAF loop or stylesheet is orphaned.
  const teardown = () => {
    clearCanvas();
    stopReplay();
    panel.remove();
    style.remove();
    document.getElementById(`${PREFIX}-chip`)?.remove();
    if (W.__hmaTeardown === teardown) delete W.__hmaTeardown;
  };
  W.__hmaTeardown = teardown;

  for (const btn of buttons) {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode!;
      if (mode === "min") return minimize();
      const wasOn = btn.classList.contains(`${PREFIX}-on`);
      reset();
      if (mode === "off") return teardown();
      if (wasOn) return say("heatmap-analytics");
      btn.classList.add(`${PREFIX}-on`);
      if (mode === "click") showHeatmap("click").catch((e) => say(String(e)));
      else if (mode === "move") showHeatmap("move").catch((e) => say(String(e)));
      else if (mode === "top") showTop().catch((e) => say(String(e)));
      else if (mode === "replay") showReplayList().catch((e) => say(String(e)));
    });
  }

  say(token ? "Ready — pick a view" : "No token in bookmarklet URL (?t=…)");
})();

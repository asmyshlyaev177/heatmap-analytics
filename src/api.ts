// All collector/API logic, separated from worker.ts so tests can import it
// without the bundled tracker/viewer text assets.
import { ENGAGEMENT_GRACE_MS } from "./engagement.ts";
import { SID_RE } from "./sid.ts";
import { IDLE_GAP_MS } from "./timeline.ts";

export interface Env {
  DB: D1Database;
  VIEWER_TOKEN?: string;
  ALLOWED_SITES?: string;
  RETENTION_DAYS?: string;
}

export const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

export const int = (v: unknown): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : 0;
};

export const frac = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(-2, Math.min(3, +n.toFixed(4))) : null;
};

// The session id is minted once in the browser (a random UUID) and kept in
// localStorage, so it arrives with every beacon and the collector derives
// nothing from the request: no IP, no User-Agent, no hashing, no salt table.
// Its value is opaque here — only its shape is pinned, and SID_RE is shared
// with the tracker so both ends can never disagree on what is acceptable.
//
// A beacon with no usable id — a tracker cached from before `sid` existed, a
// hand-rolled POST — still has to produce a NOT NULL column. It gets a
// throwaway random id: that pageview simply never chains into a journey, which
// is the honest outcome. The alternative (one shared constant) would merge every
// such visitor into a single fake session.
export const sessionId = (v: unknown): string =>
  typeof v === "string" && SID_RE.test(v) ? v : crypto.randomUUID();

// started_at is what every retention cutoff is measured against, so it cannot
// be whatever the beacon claims: a future value never ages out of any purge, a
// 0/ancient one is swept on the next cron. A legitimate tracker only ever sends
// its own Date.now(), so an
// implausible value is replaced by the receive time rather than clamped to the
// bound it broke — clamping 0 to the floor would still read as ancient. The
// cap at `now` is what enforces retention; the floor is deliberately wide
// because antedating only expires the sender's own row (started_at is written
// on insert only, so nobody can rewind someone else's pageview).
export const SA_MAX_AGE_MS = 10 * 365 * 86_400_000;

export const startedAt = (v: unknown, now: number): number => {
  const t = int(v);
  return t > now || t < now - SA_MAX_AGE_MS ? now : t;
};

// Engaged time off the beacon. A tracker that does not send one leaves NULL —
// "never measured" — which the read API answers by reconstructing a floor from
// the pageview's events; it is not the same claim as a measured zero, and the
// column is nullable so the two cannot be confused.
//
// The upper bound is exact rather than arbitrary: engagement accrues only
// while the page is open, so it cannot exceed the span to the last recorded
// event plus the one grace period that can accrue after it. That keeps a
// beacon from filing a visit as days long, and keeps the two clocks it sends
// consistent with each other.
export const activeMs = (v: unknown, durationMs: number): number | null => {
  if (v == null) return null;
  const n = int(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(n, Math.max(0, durationMs) + ENGAGEMENT_GRACE_MS));
};

// The viewer assigns pageviews.path to a full-viewport same-origin iframe's
// src, so a stored "javascript:...", "data:text/html,..." or "//evil.com/x"
// would run in the OWNER's origin. A legitimate tracker only ever sends
// location.pathname, so anything else is hostile or a bug: refuse the beacon
// instead of storing a normalised guess, which would still attribute events to
// a path nobody visited and leave a value the viewer has to keep defending.
// Rules: one leading slash and no second one (blocks "//evil.com" and, with
// the leading slash, every scheme), no backslash (browsers fold it to "/"),
// no control characters and no space (URL parsing strips them, so
// "/\tjavascript:x" must not survive as a path either).
export const isSafePath = (v: unknown): v is string => {
  if (typeof v !== "string" || v[0] !== "/" || v[1] === "/") return false;
  for (const ch of v) {
    const c = ch.charCodeAt(0);
    if (c <= 0x20 || c === 0x7f || ch === "\\") return false;
  }
  return true;
};

interface InEv {
  s?: unknown;
  k?: unknown;
  el?: unknown;
  rx?: unknown;
  ry?: unknown;
  x?: unknown;
  y?: unknown;
  t?: unknown;
}

export async function collect(req: Request, env: Env, now = Date.now()): Promise<Response> {
  const text = await req.text();
  if (text.length > 250_000) return json({ error: "too large" }, 413);

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "bad json" }, 400);
  }

  const { site, pv, path, ev } = body;
  if (
    typeof site !== "string" ||
    typeof pv !== "string" ||
    typeof path !== "string" ||
    !Array.isArray(ev)
  ) {
    return json({ error: "bad payload" }, 400);
  }
  if (!isSafePath(path)) return json({ error: "bad path" }, 400);

  if (env.ALLOWED_SITES) {
    const allowed = env.ALLOWED_SITES.split(",").map((s) => s.trim());
    if (!allowed.includes(site)) return json({ error: "unknown site" }, 403);
  }

  const sid = sessionId(body.sid);

  // session_id is only set on first insert, so a later flush of the same
  // pageview updates duration/scroll without re-keying the session — a visitor
  // who clears localStorage mid-pageview must not retro-split it.
  // Every updated column only ever grows: beacons are fire-and-forget and the
  // keepalive re-send can land after a later flush, and a rewound duration_ms
  // both loses recorded time and splits the episode chained on it. active_ms
  // takes the same treatment through a CASE rather than max(), so that a NULL
  // from a tracker predating the measurement cannot erase a value a later
  // flush already established.
  const duration = int(body.d);
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO pageviews (id, session_id, site, path, vw, vh, started_at, duration_ms, active_ms, max_scroll)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT(id) DO UPDATE SET
         duration_ms = max(pageviews.duration_ms, excluded.duration_ms),
         active_ms = CASE
           WHEN excluded.active_ms IS NULL THEN pageviews.active_ms
           ELSE max(coalesce(pageviews.active_ms, 0), excluded.active_ms)
         END,
         max_scroll = max(pageviews.max_scroll, excluded.max_scroll)`,
    ).bind(
      pv.slice(0, 64),
      sid,
      site.slice(0, 64),
      path.slice(0, 256),
      int(body.vw),
      int(body.vh),
      startedAt(body.sa, now),
      duration,
      activeMs(body.am, duration),
      Math.max(0, Math.min(100, int(body.msc))),
    ),
  ];

  const rows = (ev as InEv[])
    .filter(
      (e) =>
        e &&
        (e.k === "c" || e.k === "m" || e.k === "s" || e.k === "r") &&
        Number.isFinite(Number(e.t)),
    )
    .slice(0, 1000);

  // 9 bind params per row; D1 caps ~100 params per statement, so chunk by 10.
  // OR IGNORE + unique (pv, seq): a batch re-sent by the fetch-keepalive
  // fallback can't duplicate events.
  for (let i = 0; i < rows.length; i += 10) {
    const chunk = rows.slice(i, i + 10);
    const sql =
      `INSERT OR IGNORE INTO events (pv, seq, k, sel, rx, ry, x, y, t) VALUES ` +
      chunk.map(() => "(?,?,?,?,?,?,?,?,?)").join(",");
    stmts.push(
      env.DB.prepare(sql).bind(
        ...chunk.flatMap((e) => [
          pv.slice(0, 64),
          int(e.s),
          e.k,
          e.el ? String(e.el).slice(0, 300) : null,
          frac(e.rx),
          frac(e.ry),
          e.x == null ? null : int(e.x),
          e.y == null ? null : int(e.y),
          int(e.t),
        ]),
      ),
    );
  }

  await env.DB.batch(stmts);
  return new Response(null, { status: 204, headers: CORS });
}

export function authorized(url: URL, env: Env): boolean {
  return !!env.VIEWER_TOKEN && url.searchParams.get("t") === env.VIEWER_TOKEN;
}

export async function apiHeatmap(url: URL, env: Env): Promise<Response> {
  const site = url.searchParams.get("site") ?? "";
  const path = url.searchParams.get("path") ?? "/";
  const type = url.searchParams.get("type");
  const kind = type === "move" ? "m" : type === "rage" ? "r" : "c";
  const vwMin = int(url.searchParams.get("vwmin") ?? 0);
  const vwMax = int(url.searchParams.get("vwmax") ?? 100_000);
  const { results } = await env.DB.prepare(
    `SELECT e.sel AS sel, ROUND(e.rx, 2) AS rx, ROUND(e.ry, 2) AS ry, COUNT(*) AS n
     FROM events e JOIN pageviews p ON p.id = e.pv
     WHERE p.site = ?1 AND p.path = ?2 AND e.k = ?3
       AND p.vw BETWEEN ?4 AND ?5 AND e.sel IS NOT NULL
       AND e.sel NOT LIKE '%\\_\\_hma%' ESCAPE '\\'
     GROUP BY 1, 2, 3
     LIMIT 20000`,
  )
    .bind(site, path, kind, vwMin, vwMax)
    .all();
  return json({ points: results });
}

export async function apiElements(url: URL, env: Env): Promise<Response> {
  const site = url.searchParams.get("site") ?? "";
  const path = url.searchParams.get("path") ?? "/";
  const { results } = await env.DB.prepare(
    `SELECT e.sel AS sel, e.k AS k, COUNT(*) AS n
     FROM events e JOIN pageviews p ON p.id = e.pv
     WHERE p.site = ?1 AND p.path = ?2 AND e.k IN ('c','m','r') AND e.sel IS NOT NULL
       AND e.sel NOT LIKE '%\\_\\_hma%' ESCAPE '\\'
     GROUP BY 1, 2
     ORDER BY n DESC
     LIMIT 40`,
  )
    .bind(site, path)
    .all();
  return json({ elements: results });
}

export async function apiSessions(url: URL, env: Env): Promise<Response> {
  const site = url.searchParams.get("site") ?? "";
  const path = url.searchParams.get("path") ?? "/";
  // Two different times per row, because one number cannot be both.
  //
  // duration_ms is wall clock: the tracker reports the timestamp of its last
  // recorded event, so a tab opened and left alone for four minutes reports
  // four minutes. That is the right input for episode chaining below (it says
  // when the pageview stopped being touched) and a bad thing to show a human,
  // who reads "⏱️ 3:35" as attention.
  //
  // active_ms is attention, measured in the browser (see src/tracker.ts) and
  // read straight out of the column here. It is not derivable from what this
  // table stores: the two facts that decide it — whether the tab was on screen,
  // and whether a silence was a still read or an abandoned tab — are only
  // knowable at the moment they happen.
  //
  // NULL means a tracker that did not measure it wrote the row: everything
  // recorded before the column existed, plus beacons from pages still running
  // a bundle cached before the change. Those get reconstructed rather than
  // reported as zero — each gap between consecutive events counted up to
  // IDLE_GAP_MS, the first running from the pageview's start (LAG default 0).
  // Deliberately the short replay threshold and not ENGAGEMENT_GRACE_MS: with
  // no visibility signal to lean on, a reconstruction should be a floor, and a
  // floor is the one kind of wrong number that cannot flatter the page.
  //
  // Both bounds matter: `t` arrives from an unauthenticated beacon, so a
  // negative or rewound one must not be able to subtract from anyone's total.
  const { results } = await env.DB.prepare(
    `WITH pv AS (
       SELECT id, session_id, started_at, duration_ms, active_ms, vw, vh, max_scroll
       FROM pageviews
       WHERE site = ?1 AND path = ?2
       ORDER BY started_at DESC
       LIMIT 30
     ),
     gaps AS (
       SELECT e.pv AS pv, e.k AS k,
              e.t - LAG(e.t, 1, 0) OVER (PARTITION BY e.pv ORDER BY e.seq) AS gap
       FROM events e JOIN pv ON pv.id = e.pv
     )
     SELECT pv.id AS id, pv.session_id AS session_id, pv.started_at AS started_at,
            pv.duration_ms AS duration_ms,
            pv.vw AS vw, pv.vh AS vh, pv.max_scroll AS max_scroll,
            COALESCE(SUM(CASE WHEN g.k = 'c' THEN 1 ELSE 0 END), 0) AS clicks,
            COALESCE(SUM(CASE WHEN g.k = 'r' THEN 1 ELSE 0 END), 0) AS rage,
            COUNT(g.gap) AS events,
            COALESCE(
              pv.active_ms,
              COALESCE(SUM(max(min(g.gap, ?3), 0)), 0)
            ) AS active_ms,
            pv.active_ms IS NULL AS active_estimated
     FROM pv LEFT JOIN gaps g ON g.pv = pv.id
     GROUP BY pv.id
     ORDER BY pv.started_at DESC`,
  )
    .bind(site, path, IDLE_GAP_MS)
    .all();

  // pages = size of the row's episode, not the visitor's whole history
  const sids = [...new Set(results.map((r) => String(r.session_id)))].filter(Boolean);
  const bySid = new Map<string, { id: string; started_at: number; duration_ms: number }[]>();
  if (sids.length) {
    // A session id never rotates, so "every pageview of these 30 sessions" is
    // unbounded — it grows with the whole retention window. Only pageviews near
    // the listed ones can chain to them, so the lookup is bounded to a window
    // around the rows being annotated. An episode that somehow ran past that
    // window is undercounted in the `pages` badge and nothing else.
    const starts = results.map((r) => int(r.started_at));
    const lo = Math.min(...starts) - EPISODE_WINDOW_MS;
    const hi = Math.max(...results.map((r) => int(r.started_at) + int(r.duration_ms)))
      + EPISODE_WINDOW_MS;
    const placeholders = sids.map((_, i) => `?${i + 4}`).join(",");
    const all = await env.DB.prepare(
      `SELECT session_id, id, started_at, duration_ms FROM pageviews
       WHERE site = ?1 AND started_at BETWEEN ?2 AND ?3
         AND session_id IN (${placeholders})
       ORDER BY started_at
       LIMIT 2000`,
    )
      .bind(site, lo, hi, ...sids)
      .all<{ session_id: string; id: string; started_at: number; duration_ms: number }>();
    for (const r of all.results) {
      const list = bySid.get(r.session_id) ?? [];
      list.push({ id: r.id, started_at: r.started_at, duration_ms: r.duration_ms });
      bySid.set(r.session_id, list);
    }
  }
  for (const row of results) {
    const list = bySid.get(String(row.session_id)) ?? [];
    // episodeAround() returns its whole input for an id it cannot find, which
    // is right for a journey and wrong for a count — a row missing from the
    // bounded lookup above would report the session's size as its own.
    const known = list.some((p) => p.id === String(row.id));
    const episode = known ? episodeAround(list, String(row.id)) : [];
    row.pages = known ? episode.length : 1;
    // Which *visit* this row belongs to, keyed by the pageview the visit opened
    // with. A session_id identifies a person and never rotates, so it cannot
    // tell one visit from the next — on a site whose owner is its main visitor
    // it never varies at all. This does, and rows sharing it are the rows one
    // click replays together.
    row.episode = known ? episode[0].id : row.id;
    // …and where in that visit this row sits. The list is filtered to one path
    // while an episode spans all of them, so these run 1-based over the whole
    // journey and arrive non-contiguous (3, 7, 9) when a visitor kept coming
    // back to this page — which is the interesting part.
    row.leg = known ? episode.findIndex((p) => p.id === String(row.id)) + 1 : 1;
  }
  return json({ sessions: results });
}

// A session id outlives any single visit, so pageviews must be chained into
// journeys explicitly. Two pageviews belong to the same journey only when the
// next one starts within seconds of the previous one's last activity — the
// signature of an actual navigation (soft or full). Longer idle between
// recordings means separate replays.
export const NAV_CHAIN_GAP_MS = 30_000;

// How far either side of a listed pageview apiSessions looks for episode
// siblings. Legs chain at under NAV_CHAIN_GAP_MS apart, so reaching this far
// takes hours of unbroken navigation.
export const EPISODE_WINDOW_MS = 6 * 3_600_000;

export function episodeAround<T extends { id: string; started_at: number; duration_ms: number }>(
  sorted: T[],
  pvId: string,
): T[] {
  const i = sorted.findIndex((p) => p.id === pvId);
  if (i < 0) return sorted;
  const chained = (prev: T, next: T) =>
    next.started_at - (prev.started_at + prev.duration_ms) < NAV_CHAIN_GAP_MS;
  let lo = i;
  let hi = i;
  while (lo > 0 && chained(sorted[lo - 1], sorted[lo])) lo--;
  while (hi < sorted.length - 1 && chained(sorted[hi], sorted[hi + 1])) hi++;
  return sorted.slice(lo, hi + 1);
}

// The response is bounded, but the requested pageview must always be inside it
// — the viewer falls back to index 0 when it is missing, and would then replay
// some other pageview of the session. So the window is centred on the request
// instead of being taken from the start of the episode.
export const JOURNEY_WINDOW = 50;

export function journeyWindow<T extends { id: string }>(episode: T[], pvId: string): T[] {
  if (episode.length <= JOURNEY_WINDOW) return episode;
  const i = episode.findIndex((p) => p.id === pvId);
  const lo = Math.min(
    Math.max(0, (i < 0 ? 0 : i) - (JOURNEY_WINDOW >> 1)),
    episode.length - JOURNEY_WINDOW,
  );
  return episode.slice(lo, lo + JOURNEY_WINDOW);
}

// All pageviews of one session (a "journey"), ordered — lets the viewer
// follow the visitor across route changes during replay.
//
// The row cap has to be taken around the requested pageview, not from the start
// of the session: a session id is permanent, so a returning visitor accumulates
// pageviews without bound and `ORDER BY started_at LIMIT 200` would return the
// oldest 200 — never the recording the viewer asked to replay. Nearest-in-time
// first puts the requested pageview at row 1 by construction; chronological
// order is restored below, because episode chaining depends on it. With no ?pv
// there is no anchor, so the most recent pageviews win instead of the oldest.
export async function apiJourney(url: URL, env: Env): Promise<Response> {
  const site = url.searchParams.get("site") ?? "";
  const sid = url.searchParams.get("sid") ?? "";
  const pv = url.searchParams.get("pv") ?? "";
  const { results } = await env.DB.prepare(
    `WITH anchor AS (
       SELECT started_at AS t FROM pageviews
       WHERE id = ?3 AND site = ?1 AND session_id = ?2
     )
     SELECT id, path, started_at, duration_ms, vw, vh
     FROM pageviews
     WHERE site = ?1 AND session_id = ?2
     ORDER BY CASE
                WHEN (SELECT t FROM anchor) IS NULL THEN -started_at
                ELSE abs(started_at - (SELECT t FROM anchor))
              END
     LIMIT 200`,
  )
    .bind(site, sid, pv)
    .all<{ id: string; started_at: number; duration_ms: number }>();
  results.sort((a, b) => a.started_at - b.started_at);
  const episode = pv ? episodeAround(results, pv) : results;
  return json({ pageviews: journeyWindow(episode, pv) });
}

export async function apiReplay(url: URL, env: Env): Promise<Response> {
  const id = url.searchParams.get("pv") ?? "";
  const [meta, events] = await Promise.all([
    env.DB.prepare(`SELECT * FROM pageviews WHERE id = ?1`).bind(id).all(),
    env.DB.prepare(
      `SELECT k, sel, rx, ry, x, y, t FROM events WHERE pv = ?1 ORDER BY seq LIMIT 25000`,
    )
      .bind(id)
      .all(),
  ]);
  if (!meta.results.length) return json({ error: "not found" }, 404);
  return json({ meta: meta.results[0], events: events.results });
}

export async function purge(env: Env, now = Date.now()): Promise<void> {
  const days = Math.max(1, int(env.RETENTION_DAYS ?? 30) || 30);
  const cutoff = now - days * 86_400_000;
  await env.DB.prepare(
    `DELETE FROM events WHERE pv IN (SELECT id FROM pageviews WHERE started_at < ?1)`,
  )
    .bind(cutoff)
    .run();
  await env.DB.prepare(`DELETE FROM pageviews WHERE started_at < ?1`).bind(cutoff).run();
}

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

// Minted in the browser, opaque here; SID_RE is shared with the tracker so the
// ends cannot disagree. An unusable id becomes a throwaway rather than one
// shared constant, which would merge every such visitor into a single session.
export const sessionId = (v: unknown): string =>
  typeof v === "string" && SID_RE.test(v) ? v : crypto.randomUUID();

// Cloudflare geolocates the connecting address at the edge — the address is
// never read here. Another host is a one-string change (Vercel:
// x-vercel-ip-country). NULL off the edge, and for "XX" and Tor's "T1".
export const country = (req: Request): string | null => {
  const c = req.headers.get("CF-IPCountry");
  return c && /^[A-Z]{2}$/.test(c) && c !== "XX" ? c : null;
};

// Retention is measured against started_at, so an implausible claim is replaced
// by the receive time, not clamped — clamping 0 to the floor still reads as
// ancient. The floor is wide: antedating only expires the sender's own row.
export const SA_MAX_AGE_MS = 10 * 365 * 86_400_000;

export const startedAt = (v: unknown, now: number): number => {
  const t = int(v);
  return t > now || t < now - SA_MAX_AGE_MS ? now : t;
};

// NULL is "never measured", which the read API reconstructs a floor for and a
// measured 0 must not be confused with. The cap is exact: engagement cannot
// outrun the span to the last event plus one grace period.
export const activeMs = (v: unknown, durationMs: number): number | null => {
  if (v == null) return null;
  const n = int(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(n, Math.max(0, durationMs) + ENGAGEMENT_GRACE_MS));
};

// The viewer assigns path to a same-origin iframe src, so a stored
// "javascript:", "data:" or "//evil.com" would run in the OWNER's origin.
// One leading slash and no second (kills schemes and protocol-relative), no
// backslash (browsers fold it to "/"), no control chars or space (URL parsing
// strips them, so "/\tjavascript:x" must not survive either).
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

  // session_id and country are insert-only: a later flush must not re-key or
  // re-place a visit. Every updated column only grows — beacons are
  // fire-and-forget and a keepalive re-send can land after a later flush, and a
  // rewound duration_ms splits the episode chained on it. active_ms uses CASE,
  // not max(), so a NULL from an older tracker cannot erase a measured value.
  const duration = int(body.d);
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO pageviews (id, session_id, site, path, vw, vh, started_at, duration_ms, active_ms, max_scroll, country)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
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
      country(req),
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

  // 9 params/row against D1's ~100 per statement. OR IGNORE + unique (pv, seq):
  // a keepalive re-send cannot duplicate.
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

// ---------- replay tickets ----------
//
// A replay runs on the recorded page, so whatever authorises it is readable by
// every script there and sits in the address bar — never the VIEWER_TOKEN. A
// ticket is random, minutes long, and scoped to one visitor on one site. Not
// single-use: one replay is many reads, so the bound is time and scope.
export const TICKET_TTL_MS = 10 * 60_000;

// Shape only, like SID_RE: the lookup below is string-typed.
export const TICKET_RE = /^[\w-]{16,64}$/;

export type Auth =
  | { kind: "token" }
  | { kind: "ticket"; site: string; pv: string; sid: string; expires_at: number };

export const TOKEN_AUTH: Auth = { kind: "token" };

interface TicketRow {
  site: string;
  pv: string;
  session_id: string;
  expires_at: number;
}

// The token wins when both are present: it needs no database round trip, and a
// ticket only ever widens a request that had no other way in.
export async function authenticate(url: URL, env: Env, now = Date.now()): Promise<Auth | null> {
  if (authorized(url, env)) return TOKEN_AUTH;
  const tk = url.searchParams.get("tk") ?? "";
  if (!TICKET_RE.test(tk)) return null;
  const { results } = await env.DB.prepare(
    `SELECT site, pv, session_id, expires_at FROM replay_tickets
     WHERE id = ?1 AND expires_at > ?2`,
  )
    .bind(tk, now)
    .all<TicketRow>();
  const row = results[0];
  if (!row) return null;
  return {
    kind: "ticket",
    site: row.site,
    pv: row.pv,
    sid: row.session_id,
    expires_at: row.expires_at,
  };
}

// POST /api/ticket?pv=<id> — token only. Scope is read off the pageview, never
// from the caller, so a ticket cannot name a site or visitor it does not own.
export async function apiTicketMint(url: URL, env: Env, now = Date.now()): Promise<Response> {
  const pv = url.searchParams.get("pv") ?? "";
  const { results } = await env.DB.prepare(
    `SELECT id, site, path, session_id FROM pageviews WHERE id = ?1`,
  )
    .bind(pv)
    .all<{ id: string; site: string; path: string; session_id: string }>();
  const row = results[0];
  if (!row) return json({ error: "not found" }, 404);

  const id = crypto.randomUUID();
  const expires_at = now + TICKET_TTL_MS;
  await env.DB.prepare(
    `INSERT INTO replay_tickets (id, site, pv, session_id, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(id, row.site, row.id, row.session_id, expires_at)
    .run();
  return json({ tk: id, pv: row.id, site: row.site, path: row.path, expires_at });
}

// GET /api/ticket — which recording a deep link was sent to play. A ticket
// describes itself; a token caller names one.
export async function apiTicketResolve(url: URL, env: Env, auth: Auth): Promise<Response> {
  if (auth.kind === "ticket") {
    return json({ site: auth.site, pv: auth.pv, sid: auth.sid, expires_at: auth.expires_at });
  }
  const tk = url.searchParams.get("tk") ?? "";
  if (!TICKET_RE.test(tk)) return json({ error: "no ticket" }, 400);
  const { results } = await env.DB.prepare(
    `SELECT site, pv, session_id, expires_at FROM replay_tickets WHERE id = ?1`,
  )
    .bind(tk)
    .all<TicketRow>();
  const row = results[0];
  if (!row) return json({ error: "not found" }, 404);
  return json({ site: row.site, pv: row.pv, sid: row.session_id, expires_at: row.expires_at });
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
  // Two clocks, because one number cannot be both. duration_ms is wall clock,
  // right for the episode chaining below and wrong to show a human; active_ms
  // is attention, measured in the browser and not derivable from this table.
  // NULL is never-measured, rebuilt as a floor from gaps capped at IDLE_GAP_MS
  // — the replay threshold, not ENGAGEMENT_GRACE_MS, because a floor is the one
  // wrong number that cannot flatter the page. Both bounds guard a rewound `t`.
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
    // A never-rotating id makes "every pageview of these sessions" grow with the
    // retention window. Only nearby ones can chain, so the lookup is windowed;
    // an episode past it undercounts `pages` and nothing else.
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
    // episodeAround() returns its whole input for an id it cannot find: right
    // for a journey, wrong for a count.
    const known = list.some((p) => p.id === String(row.id));
    const episode = known ? episodeAround(list, String(row.id)) : [];
    row.pages = known ? episode.length : 1;
    // Which visit this row belongs to. session_id identifies a person and never
    // rotates, so it cannot tell one visit from the next; this can, and rows
    // sharing it are what one click replays together.
    row.episode = known ? episode[0].id : row.id;
    // 1-based over the whole journey, so a list filtered to one path shows them
    // non-contiguous (3, 7, 9) when a visitor kept coming back — the point.
    row.leg = known ? episode.findIndex((p) => p.id === String(row.id)) + 1 : 1;
  }
  return json({ sessions: results });
}

// A session id outlives a visit, so journeys are chained explicitly: the next
// pageview opening within seconds of the last activity is a navigation.
export const NAV_CHAIN_GAP_MS = 30_000;

// How far apiSessions looks for episode siblings — hours of unbroken
// navigation to reach it.
export const EPISODE_WINDOW_MS = 6 * 3_600_000;

// One definition of "same visit", shared by the journey walk and the dashboard
// list — two answers would put a different page count on a row than its replay.
export const chainedNav = (
  prev: { started_at: number; duration_ms: number },
  next: { started_at: number },
): boolean => next.started_at - (prev.started_at + prev.duration_ms) < NAV_CHAIN_GAP_MS;

export function episodeAround<T extends { id: string; started_at: number; duration_ms: number }>(
  sorted: T[],
  pvId: string,
): T[] {
  const i = sorted.findIndex((p) => p.id === pvId);
  if (i < 0) return sorted;
  const chained = chainedNav;
  let lo = i;
  let hi = i;
  while (lo > 0 && chained(sorted[lo - 1], sorted[lo])) lo--;
  while (hi < sorted.length - 1 && chained(sorted[hi], sorted[hi + 1])) hi++;
  return sorted.slice(lo, hi + 1);
}

// Centred on the requested pageview, not the start of the episode: the viewer
// falls back to index 0 when it is missing and would replay the wrong one.
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

// ---------- dashboard reads ----------
//
// "What happened anywhere", against the viewer's "on this page" — its own
// endpoint, because /api/sessions is scoped to one site and path and the bounds
// that make it safe are derived from that scope.

// Pageviews one /api/replays call scans. Index-driven with no events join, so
// cheap; the costly per-pageview statistics run on the returned page only.
export const REPLAYS_SCAN_CAP = 2000;
export const REPLAYS_PAGE_MAX = 100;
// D1 refuses a statement with more than 100 bound parameters. Exclusions and
// the id lists below are the two places a caller could push past that.
export const MAX_EXCLUSIONS = 40;
export const STATS_CHUNK = 80;

// Epoch ms, or a YYYY-MM-DD the dashboard did not convert. Anything else falls
// back rather than becoming a NaN that SQLite binds as NULL and never matches.
export const timeParam = (v: string | null, fallback: number): number => {
  if (!v) return fallback;
  if (/^-?\d+$/.test(v)) return Number(v);
  const t = /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : Date.parse(v);
  return Number.isFinite(t) ? t : fallback;
};

export interface LegRow {
  id: string;
  session_id: string;
  site: string;
  path: string;
  started_at: number;
  duration_ms: number;
  active_ms: number | null;
  vw: number;
  vh: number;
  max_scroll: number;
  country: string | null;
  clicks?: number;
  rage?: number;
  events?: number;
  active_estimated?: number;
}

export interface Visit {
  episode: string;
  site: string;
  session_id: string;
  started_at: number;
  ended_at: number;
  entry_path: string;
  pages: number;
  duration_ms: number;
  active_ms: number;
  active_estimated: number;
  clicks: number;
  rage: number;
  events: number;
  max_scroll: number;
  vw: number;
  vh: number;
  country: string | null;
  legs: LegRow[];
}

// One row per uninterrupted run of navigation — the unit a replay plays back,
// which a never-rotating session id cannot identify on its own. Grouped by site
// too: a forged beacon can claim any pair, and a cross-site visit has no
// journey to replay.
export function buildVisits(rows: LegRow[]): Visit[] {
  const bySession = new Map<string, LegRow[]>();
  for (const row of rows) {
    const key = `${row.site} ${row.session_id}`;
    const list = bySession.get(key);
    if (list) list.push(row);
    else bySession.set(key, [row]);
  }

  const visits: Visit[] = [];
  for (const list of bySession.values()) {
    list.sort((a, b) => a.started_at - b.started_at || (a.id < b.id ? -1 : 1));
    let legs: LegRow[] = [];
    const close = () => {
      if (legs.length) visits.push(summarise(legs));
      legs = [];
    };
    for (const row of list) {
      if (legs.length && !chainedNav(legs[legs.length - 1], row)) close();
      legs.push(row);
    }
    close();
  }
  // Id as the tiebreak: two pageviews can share a millisecond, and an unstable
  // order makes a paginated list repeat or skip.
  visits.sort((a, b) => b.started_at - a.started_at || (a.episode < b.episode ? 1 : -1));
  return visits;
}

// The visit's own numbers: keyed on the leg it opened with (what /api/journey
// anchors on), ended at the last leg's last activity, totals summed over legs.
function summarise(legs: LegRow[]): Visit {
  const head = legs[0];
  const tail = legs[legs.length - 1];
  const sum = (pick: (l: LegRow) => number) => legs.reduce((n, l) => n + pick(l), 0);
  return {
    episode: head.id,
    site: head.site,
    session_id: head.session_id,
    started_at: head.started_at,
    ended_at: tail.started_at + tail.duration_ms,
    entry_path: head.path,
    pages: legs.length,
    duration_ms: tail.started_at + tail.duration_ms - head.started_at,
    active_ms: sum((l) => l.active_ms ?? 0),
    // One unmeasured leg makes the total a floor. Read off the flag, not
    // active_ms, which stops being null once the reconstruction fills it in.
    active_estimated: legs.some((l) => l.active_estimated) ? 1 : 0,
    clicks: sum((l) => l.clicks ?? 0),
    rage: sum((l) => l.rage ?? 0),
    events: sum((l) => l.events ?? 0),
    max_scroll: legs.reduce((n, l) => Math.max(n, l.max_scroll), 0),
    vw: head.vw,
    vh: head.vh,
    // the leg the deep link replays from; legs disagree only on a mid-visit VPN
    country: head.country,
    legs,
  };
}

// Per-pageview statistics for the returned page, chunked under D1's parameter
// ceiling. Same IDLE_GAP_MS reconstruction as /api/sessions.
interface LegStats {
  clicks: number;
  rage: number;
  events: number;
  idle_ms: number;
}

async function legStats(env: Env, ids: string[]): Promise<Map<string, LegStats>> {
  const out = new Map<string, LegStats>();
  for (let i = 0; i < ids.length; i += STATS_CHUNK) {
    const chunk = ids.slice(i, i + STATS_CHUNK);
    const { results } = await env.DB.prepare(
      `WITH g AS (
         SELECT pv, k, t - LAG(t, 1, 0) OVER (PARTITION BY pv ORDER BY seq) AS gap
         FROM events WHERE pv IN (${chunk.map(() => "?").join(",")})
       )
       SELECT pv,
              COALESCE(SUM(CASE WHEN k = 'c' THEN 1 ELSE 0 END), 0) AS clicks,
              COALESCE(SUM(CASE WHEN k = 'r' THEN 1 ELSE 0 END), 0) AS rage,
              COUNT(*) AS events,
              COALESCE(SUM(max(min(gap, ?), 0)), 0) AS idle_ms
       FROM g GROUP BY pv`,
    )
      .bind(...chunk, IDLE_GAP_MS)
      .all<LegStats & { pv: string }>();
    for (const r of results) out.set(r.pv, r);
  }
  return out;
}

// GET /api/replays — the dashboard's list: visits across every site, in a date
// range, minus the session ids the owner is hiding.
export async function apiReplays(url: URL, env: Env, now = Date.now()): Promise<Response> {
  const p = url.searchParams;
  // A pageview is stamped by the browser's clock, so "now" is not a safe upper
  // bound — a visitor a minute ahead would drop out of an unbounded range.
  const to = timeParam(p.get("to"), now + 3_600_000);
  const from = Math.min(timeParam(p.get("from"), 0), to);
  const site = p.get("site") ?? "";
  const q = (p.get("q") ?? "").trim().toLowerCase();
  const limit = Math.max(1, Math.min(REPLAYS_PAGE_MAX, int(p.get("limit")) || 25));
  const offset = Math.max(0, int(p.get("offset")));
  // Filtered to the shared id shape: a malformed entry in a NOT IN list is not
  // an error in SQLite but a NULL that makes the predicate return nothing.
  const exclude = (p.get("exclude") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => SID_RE.test(s))
    .slice(0, MAX_EXCLUSIONS);

  // Padded by one episode window: a visit straddling the bound would otherwise
  // be listed headless and replay from its middle. The pad is dropped below.
  const where = ["started_at >= ?", "started_at < ?"];
  const binds: unknown[] = [from - EPISODE_WINDOW_MS, to];
  // Appended only when set: `(? = '' OR site = ?)` would read the same and cost
  // the (site, path, started_at) index, which SQLite cannot use through an OR.
  if (site) {
    where.push("site = ?");
    binds.push(site);
  }
  if (exclude.length) {
    where.push(`session_id NOT IN (${exclude.map(() => "?").join(",")})`);
    binds.push(...exclude);
  }
  binds.push(REPLAYS_SCAN_CAP);

  const scan = await env.DB.prepare(
    `SELECT id, session_id, site, path, started_at, duration_ms, active_ms, vw, vh, max_scroll, country
     FROM pageviews
     WHERE ${where.join(" AND ")}
     ORDER BY started_at DESC, id DESC
     LIMIT ?`,
  )
    .bind(...binds)
    .all<LegRow>();

  const truncated = scan.results.length >= REPLAYS_SCAN_CAP;
  // Decided here, while active_ms still distinguishes "measured 0" from "never
  // measured" — the reconstruction below overwrites the NULL either way.
  for (const row of scan.results) row.active_estimated = row.active_ms == null ? 1 : 0;
  let visits = buildVisits(scan.results)
    // the pad is scaffolding for chaining, not part of the answer
    .filter((v) => v.ended_at >= from)
    // Zero duration on every leg is a pageview with no events and no replay to
    // open. Dropped here and not in the scan, where losing a middle leg would
    // split the visit; ?empty=1 asks for them back.
    .filter(
      (v) => p.get("empty") === "1" || v.legs.some((l) => l.duration_ms > 0 || l.max_scroll > 0),
    );
  // Path search matches any leg, not just the entry: the interesting question
  // is "which visits touched /pricing", and the answer is the whole visit.
  if (q) visits = visits.filter((v) => v.legs.some((l) => l.path.toLowerCase().includes(q)));

  const total = visits.length;
  const page = visits.slice(offset, offset + limit);
  const stats = await legStats(env, page.flatMap((v) => v.legs.map((l) => l.id)));
  for (const visit of page) {
    for (const leg of visit.legs) {
      const s = stats.get(leg.id);
      leg.clicks = s?.clicks ?? 0;
      leg.rage = s?.rage ?? 0;
      leg.events = s?.events ?? 0;
      leg.active_ms = leg.active_ms ?? s?.idle_ms ?? 0;
    }
    Object.assign(visit, summarise(visit.legs));
  }

  return json({ visits: page, total, from, to, truncated, scanned: scan.results.length });
}

// GET /api/sites — the dashboard's filter. "visitors" counts browsers, not
// people: an id is per-origin, per-device, and never rotates.
export async function apiSites(url: URL, env: Env, now = Date.now()): Promise<Response> {
  const to = timeParam(url.searchParams.get("to"), now + 3_600_000);
  const from = Math.min(timeParam(url.searchParams.get("from"), 0), to);
  const { results } = await env.DB.prepare(
    `SELECT site,
            COUNT(*) AS pageviews,
            COUNT(DISTINCT session_id) AS visitors,
            MAX(started_at) AS last_seen
     FROM pageviews
     WHERE started_at >= ?1 AND started_at < ?2
     GROUP BY site
     ORDER BY last_seen DESC
     LIMIT 500`,
  )
    .bind(from, to)
    .all();
  return json({ sites: results, from, to });
}

// One session's pageviews, so the viewer can follow route changes during a
// replay. Ordered nearest-in-time to the requested one: a permanent id
// accumulates without bound, and `LIMIT 200` from the start would never include
// the recording asked for. Chronological order is restored below, which the
// episode chaining depends on; with no ?pv the newest win.
export async function apiJourney(url: URL, env: Env, auth: Auth = TOKEN_AUTH): Promise<Response> {
  const site = url.searchParams.get("site") ?? "";
  const sid = url.searchParams.get("sid") ?? "";
  const pv = url.searchParams.get("pv") ?? "";
  // Checked, not overridden: a link asking for another visitor's journey is
  // refused rather than quietly answered with someone else's recording.
  if (auth.kind === "ticket" && (site !== auth.site || sid !== auth.sid)) {
    return json({ error: "forbidden" }, 403);
  }
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

export async function apiReplay(url: URL, env: Env, auth: Auth = TOKEN_AUTH): Promise<Response> {
  const id = url.searchParams.get("pv") ?? "";
  const [meta, events] = await Promise.all([
    // Named, not `*`: a ticket reads this on an origin the owner does not
    // control, so a new column must be a decision, not disclosure by default.
    env.DB.prepare(
      `SELECT id, session_id, site, path, vw, vh, started_at, duration_ms, active_ms, max_scroll
       FROM pageviews WHERE id = ?1`,
    )
      .bind(id)
      .all(),
    env.DB.prepare(
      `SELECT k, sel, rx, ry, x, y, t FROM events WHERE pv = ?1 ORDER BY seq LIMIT 25000`,
    )
      .bind(id)
      .all(),
  ]);
  if (!meta.results.length) return json({ error: "not found" }, 404);
  // The only read taking a bare pageview id, so a ticket would otherwise reach
  // every recording. Pinning site + visitor still plays the whole journey.
  const row = meta.results[0] as { site?: unknown; session_id?: unknown };
  if (auth.kind === "ticket" && (row.site !== auth.site || row.session_id !== auth.sid)) {
    return json({ error: "forbidden" }, 403);
  }
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
  // Minutes, not days: swept against the clock, not the retention horizon. An
  // expired ticket is already refused on use; this only bounds the table.
  await env.DB.prepare(`DELETE FROM replay_tickets WHERE expires_at < ?1`).bind(now).run();
}

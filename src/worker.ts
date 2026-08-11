import DASHBOARD from "./generated/dashboard.txt";
import TRACKER from "./generated/tracker.txt";
import VIEWER from "./generated/viewer.txt";
import {
  CORS,
  type Env,
  apiElements,
  apiHeatmap,
  apiJourney,
  apiReplay,
  apiReplays,
  apiSessions,
  apiSites,
  apiTicketMint,
  apiTicketResolve,
  authenticate,
  collect,
  json,
  purge,
} from "./api";

export type { Env };

const js = (body: string, cacheControl = "public, max-age=300") =>
  new Response(body, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": cacheControl,
      ...CORS,
    },
  });

// The dashboard is the owner's console over every connected site. It carries
// no CORS header (nothing should fetch it cross-origin), refuses to be framed
// by any of the sites it reports on, and is never cached — a stale copy would
// hide a redeploy the way a cached viewer used to.
const html = (body: string) =>
  new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    },
  });

// Routing takes the bundles as arguments so tests can exercise it without
// the *.txt text imports, which only a bundler can resolve.
export const makeWorker = (tracker: string, viewer: string, dashboard: string) => ({
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (req.method === "POST" && pathname === "/collect") {
      try {
        return await collect(req, env);
      } catch (err) {
        // detail stays in the log — the response must not hand SQL/schema
        // fragments to an unauthenticated caller
        console.error("collect failed", err);
        return json({ error: "server error" }, 500);
      }
    }

    if (pathname.startsWith("/api/")) {
      const auth = await authenticate(url, env);
      if (!auth) return json({ error: "unauthorized" }, 401);
      // Two credentials reach this point and they are not equivalent. The
      // VIEWER_TOKEN is the owner's and reads everything. A ticket belongs to
      // a deep link, runs on a page the owner does not control, and may only
      // read the one visitor's recordings it was minted for — so the aggregate
      // endpoints below are gated on the token a second time rather than on
      // "authenticated".
      const owner = auth.kind === "token";

      if (req.method === "POST") {
        if (pathname === "/api/ticket") {
          return owner ? apiTicketMint(url, env) : json({ error: "forbidden" }, 403);
        }
        return json({ error: "method" }, 405);
      }
      if (req.method !== "GET") return json({ error: "method" }, 405);

      if (pathname === "/api/ticket") return apiTicketResolve(url, env, auth);
      if (pathname === "/api/journey") return apiJourney(url, env, auth);
      if (pathname === "/api/replay") return apiReplay(url, env, auth);

      if (!owner) return json({ error: "forbidden" }, 403);
      if (pathname === "/api/heatmap") return apiHeatmap(url, env);
      if (pathname === "/api/elements") return apiElements(url, env);
      if (pathname === "/api/sessions") return apiSessions(url, env);
      if (pathname === "/api/replays") return apiReplays(url, env);
      if (pathname === "/api/sites") return apiSites(url, env);
      return json({ error: "not found" }, 404);
    }

    if (req.method !== "GET") return json({ error: "method" }, 405);

    if (pathname === "/tracker.js") return js(tracker);
    // owner tools — must always be fresh, a stale cached copy hides updates
    if (pathname === "/viewer.js") return js(viewer, "no-cache");
    if (pathname === "/dashboard" || pathname === "/dashboard/") return html(dashboard);

    return new Response(
      "heatmap-analytics collector\n\n" +
        "POST /collect      — tracker beacon ingest\n" +
        "GET  /tracker.js   — embed script\n" +
        "GET  /viewer.js    — heatmap/replay overlay (token required for data)\n" +
        "GET  /dashboard    — replays across every site (token required for data)\n" +
        "GET  /api/*        — aggregates, ?t=<VIEWER_TOKEN>\n",
      { headers: { "Content-Type": "text/plain" } },
    );
  },

  async scheduled(_event: unknown, env: Env): Promise<void> {
    await purge(env);
  },
});

export default makeWorker(TRACKER, VIEWER, DASHBOARD);

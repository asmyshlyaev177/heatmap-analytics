import TRACKER from "./generated/tracker.txt";
import VIEWER from "./generated/viewer.txt";
import {
  CORS,
  type Env,
  apiElements,
  apiHeatmap,
  apiJourney,
  apiReplay,
  apiSessions,
  authorized,
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

// Routing takes the two bundles as arguments so tests can exercise it without
// the *.txt text imports, which only a bundler can resolve.
export const makeWorker = (tracker: string, viewer: string) => ({
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

    if (req.method !== "GET") return json({ error: "method" }, 405);

    if (pathname === "/tracker.js") return js(tracker);
    // owner tool — must always be fresh, a stale cached copy hides updates
    if (pathname === "/viewer.js") return js(viewer, "no-cache");

    if (pathname.startsWith("/api/")) {
      if (!authorized(url, env)) return json({ error: "unauthorized" }, 401);
      if (pathname === "/api/heatmap") return apiHeatmap(url, env);
      if (pathname === "/api/elements") return apiElements(url, env);
      if (pathname === "/api/sessions") return apiSessions(url, env);
      if (pathname === "/api/journey") return apiJourney(url, env);
      if (pathname === "/api/replay") return apiReplay(url, env);
      return json({ error: "not found" }, 404);
    }

    return new Response(
      "heatmap-analytics collector\n\n" +
        "POST /collect      — tracker beacon ingest\n" +
        "GET  /tracker.js   — embed script\n" +
        "GET  /viewer.js    — heatmap/replay overlay (token required for data)\n" +
        "GET  /api/*        — aggregates, ?t=<VIEWER_TOKEN>\n",
      { headers: { "Content-Type": "text/plain" } },
    );
  },

  async scheduled(_event: unknown, env: Env): Promise<void> {
    await purge(env);
  },
});

export default makeWorker(TRACKER, VIEWER);

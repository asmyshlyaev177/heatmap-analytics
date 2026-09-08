# heatmap-analytics

Self-hosted behavior analytics on Cloudflare Workers + D1. Clicks, hover/move
heatmaps, scroll depth, rage-click detection, and ghost-cursor session replay —
rendered directly on the live page. No cookies and no third-party scripts; the
tracker is ~1.7KB gzipped and stores exactly one thing on the device, a random
visitor id in `localStorage`.

Deployed: `https://heatmap-analytics.asmyshlyaev177.workers.dev`
(D1: `heatmap-analytics`, region EEUR)

## How it works

```text
site (any host)          Cloudflare (this repo)
┌──────────────┐  beacon  ┌─────────┐   ┌────┐
│ tracker.js   │ ───────► │ Worker  │ ► │ D1 │
│ ~1.7KB gzip  │          │ /collect│   └────┘
└──────────────┘          └────┬────┘
       ▲                       ├──────────────► /dashboard   every site's
       │                       │ /api/* (token)               visits, filtered
       │ #__hma=<ticket>  ┌────▼────────────┐                       │
       └──────────────────│ viewer.js       │  bookmarklet overlay: │
          "replay this"   │ on the live page│  heatmaps, top, replay◄
                          └─────────────────┘
```

- **Tracker** records clicks, pointer moves, scroll depth and rage clicks.
  Events are element-anchored (`selector + relative x/y`), so heatmaps survive
  responsive breakpoints and content edits. Skips automated browsers, so
  Playwright and Lighthouse runs never pollute the data.
- **Worker** ingests beacons into D1, serves token-gated aggregate APIs, and
  purges data older than `RETENTION_DAYS` nightly.
- **Viewer** resolves stored selectors against the *current* DOM: click heatmap,
  hover heatmap, top elements, and session replay with a ghost cursor.
- **Dashboard** lists visits across every connected site and opens any of them
  as a replay on the page it was recorded on.

Each pageview also carries the visitor's country, which Cloudflare resolves at
the edge — no address is read or stored.

## Add to a site

```html
<script async src="https://heatmap-analytics.asmyshlyaev177.workers.dev/tracker.js"></script>
```

That is the whole embed. The collector URL is baked into the bundle at build
time, and the site key — what keeps one site's data separate from another's — is
the page's own `location.hostname`, deliberately not an attribute you could copy
onto an unrelated host.

**Load it from the Worker, don't vendor a copy.** `Cache-Control: public,
max-age=300`, so a redeploy reaches every site within five minutes. A copy in a
site's own `public/` needs a content hash *and* a manual re-sync on every tracker
change, and a missed sync ships a stale tracker in silence. That went wrong here
once already.

React (TanStack Start, in the root document), gated the way a GA4 tag would be —
`react-horizontal-scrolling-menu.dev` runs it like this:

```tsx
{import.meta.env.PROD && (
  <script async src="https://heatmap-analytics.asmyshlyaev177.workers.dev/tracker.js" />
)}
```

Astro, gated so `astro dev` and local builds stay out of the data:

```astro
{__HM_ENABLED__ && (
  <script async is:inline
    src="https://heatmap-analytics.asmyshlyaev177.workers.dev/tracker.js" />
)}
```

Point the tracker somewhere else at build time with
`HM_ENDPOINT=https://my-collector.example pnpm build`. The build prints the
endpoint it baked in, because a bundle built with the wrong one looks identical
to a right one.

## View the data

Two surfaces, answering two different questions.

### Dashboard

`https://heatmap-analytics.asmyshlyaev177.workers.dev/dashboard`

"What happened anywhere." Asks for the `VIEWER_TOKEN` once and keeps it in that
browser. Each row is a **visit** — one uninterrupted run of navigation — with
its visitor and visit badges, country, engaged time, clicks, rage and scroll
depth. Filter by site, date range and path; hide visitors you don't want to see
(a per-device preference, not a server rule). ▶ Replay opens the recorded page
and plays the visit back on it.

### Bookmarklet

"What happened on the page I am standing on", which is the only place a heatmap
can be drawn. Token lives in `.dev.vars`, gitignored — never commit it:

```text
javascript:(function(){var s=document.createElement('script');s.src='https://heatmap-analytics.asmyshlyaev177.workers.dev/viewer.js?t=<VIEWER_TOKEN>';document.body.appendChild(s)})()
```

Open any tracked page, hit the bookmarklet, pick a view. No site parameter
needed — the viewer falls back to `location.hostname`, the same key the tracker
filed under. Append `&site=<SITE>` to read one site's data while standing
somewhere else.

### Replay deep links

▶ Replay opens `https://<site><path>#__hma=<ticket>`. The tracker already on that
page sees the fragment, loads the viewer, and records nothing for that page load
— the owner watching a replay is not a visit.

The link never carries `VIEWER_TOKEN`. It carries a **ticket**: a random id
valid for ten minutes that can read one visitor's recordings on one site and
nothing else. The page it lands on belongs to the tracked site, where every
script could read whatever authorised it.

## API

All read endpoints require `?t=<VIEWER_TOKEN>`. The three marked ⊙ also accept
`?tk=<ticket>`, scoped to that ticket's visitor and site; everything else answers
403 to a ticket.

| Endpoint | Returns |
| --- | --- |
| `POST /collect` | beacon ingest (no auth; optional `ALLOWED_SITES` allowlist) |
| `GET /api/heatmap?site&path&type=click/move/rage[&vwmin&vwmax]` | bucketed points `{sel, rx, ry, n}` |
| `GET /api/elements?site&path` | per-element click/hover/rage counts |
| `GET /api/sessions?site&path` | recent pageviews with click/rage/scroll stats, `active_ms` (+ `active_estimated`) beside the wall-clock `duration_ms`, plus each one's `episode` key, `leg` and size |
| `GET /api/replays?[site&from&to&q&exclude&limit&offset&empty]` | visits across every site, newest first, with their legs — the dashboard's list |
| `GET /api/sites?[from&to]` | site keys reporting in the range, with pageview and browser counts |
| `POST /api/ticket?pv=<id>` | mints a replay ticket for that pageview's visitor and site |
| `GET /api/ticket?tk=<id>` ⊙ | what the ticket may replay: `{site, pv, sid, expires_at}` |
| `GET /api/journey?site&sid[&pv]` ⊙ | the episode around `pv`, in order — the legs a replay walks |
| `GET /api/replay?pv=<id>` ⊙ | ordered event stream for one pageview |

## Commands

```bash
pnpm build            # bundle tracker/viewer + dashboard (runs on deploy)
pnpm deploy           # pending migrations, then build + wrangler deploy
pnpm db:schema        # bootstrap a fresh remote D1 — see migrations/README.md
pnpm db:migrate       # pending migrations only, without deploying
pnpm dev              # wrangler dev (uses .dev.vars for VIEWER_TOKEN)
pnpm test             # unit tests, then Playwright e2e
pnpm test:unit        # node:test against a fake D1 (fast, no network)
pnpm test:e2e         # build + Playwright (real tracker/viewer in Chromium)
pnpm typecheck        # tsc --noEmit
```

## Config

- `VIEWER_TOKEN` (secret) — `wrangler secret put VIEWER_TOKEN`; also in
  `.dev.vars` for local dev.
- `ALLOWED_SITES` (var, optional) — comma-separated allowlist of site keys
  (hostnames) for `/collect`; unset accepts any. This is what actually stops a
  forged beacon filing under one of your sites.
- `RETENTION_DAYS` (var) — nightly purge horizon, default 30.

**Budget.** The D1 free tier allows 100k rows written/day and 5GB of storage. An
engaged 2-minute visit writes roughly 300–800 event rows; a short landing-page
visit far fewer. That is comfortably hundreds of engaged sessions/day across all
sites. If it gets tight: raise `SAMPLE_MS`, lower `MAX_EVENTS`, or reduce
`RETENTION_DAYS`.

## Layout

```text
src/            four surfaces + what they share  → src/CLAUDE.md
  api/            collector and read endpoints   → src/api/CLAUDE.md
  tracker/        what runs on a tracked page    → src/tracker/CLAUDE.md
  viewer/         the bookmarklet overlay        → src/viewer/CLAUDE.md
  dashboard/      the owner's console            → src/dashboard/CLAUDE.md
  shared/         constants both ends must agree → src/shared/CLAUDE.md
  worker.ts       routing
migrations/     one numbered file per change     → migrations/README.md
test/, e2e/     unit and end-to-end suites       → test/CLAUDE.md
scripts/        build.mjs, db-baseline.mjs
schema.sql      the shape of a fresh database
```

Design decisions and the failures behind them live in those `CLAUDE.md` files,
next to the code they constrain, rather than here.

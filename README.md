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

- **Tracker** records clicks, pointer moves (150ms sampling), scroll depth and
  rage clicks (3+ clicks within 30px inside 900ms). Events are element-anchored
  (`selector + relative x/y`), so heatmaps survive responsive breakpoints and
  content edits. Batches flush via one `sendBeacon` (text/plain → no CORS
  preflight). Skips `navigator.webdriver` browsers, so Playwright/Lighthouse
  runs never pollute data.
- **Worker** ingests beacons into D1 (idempotent via unique `(pv, seq)`),
  serves token-gated aggregate APIs, and purges data older than
  `RETENTION_DAYS` (default 30) via a nightly cron.
- **Viewer** resolves stored selectors against the *current* DOM and renders:
  click heatmap (+ red rings on rage points), hover heatmap, top-elements
  list, and session replay (ghost cursor + click ripples + scroll), with a
  device filter (mobile/tablet/desktop).
- **Dashboard** (`/dashboard`) lists visits across every connected site with a
  date range, a site filter and a path search, and opens any of them as a
  replay on the page it was recorded on.

## Sessions

`session_id` is a random id the browser mints once with `crypto.randomUUID()`
and keeps under the `hma_sid` key in `localStorage`. It rides along on every
beacon. The collector derives nothing of its own — no IP, no User-Agent, no
hash, no salt table — and treats the value as opaque apart from pinning its
shape (`/^[\w-]{8,64}$/`), because an unauthenticated beacon should not be able
to put arbitrary text in a column the viewer sends back out as a query
parameter. A value that fails the check is replaced by a throwaway id, so a
malformed beacon still records but doesn't join anyone else's session.

That shape and that key name live in `src/sid.ts` and are imported by both ends,
not restated. If the two ever disagreed, the tracker would forward ids the
collector refuses — and a refused id becomes a throwaway, so journeys would stop
chaining with nothing logged anywhere.

The tracker reads that one key, and writes it on a first visit or when the
stored value isn't one it recognises. Nothing else on the device is touched —
not cookies, not `sessionStorage`, not IndexedDB. Where `localStorage` throws
(Safari private mode, some embedded webviews) it falls back to an in-memory id
for that page load: the visit still records, it just won't chain to another one.

**A visitor is not a visit.** Because the id never rotates it identifies a
visitor, so the replay list can't group by it directly — pageviews are chained
into an *episode* instead: each one starting under 30s after the previous one's
last recorded activity, which is what a real navigation looks like
(`NAV_CHAIN_GAP_MS`). A longer idle starts a new episode, so `🔀 3 pages` on a
row means three pages in that visit and not three in the visitor's history.
Both reads are capped, because a permanent id has no bound on how many rows it
accumulates: `/api/journey` takes at most 200 rows from the database and returns
at most 50, windowed so the requested pageview is always inside; `/api/sessions`
looks for episode siblings within ±6h of the rows it is annotating.

**Why it changed.** This used to be a Plausible/Fathom-style server-side hash,
`sha256(daily_salt | site | ip | user_agent)[:32]`, rotated daily out of a
`salts` table. Nothing was stored on the device, but the identity was really
"network + browser", which is wrong in both directions: a phone that moves from
wifi to mobile data mid-visit became two visitors, and two people behind one
office NAT on the same browser version became one. A random client-side id is
exact on both counts, and journeys stop breaking at UTC midnight.

**What it costs.** A `localStorage` identifier counts as storage on the device
under ePrivacy, so this is no longer the consent-free posture the hash had — an
EU-facing site should treat it like a first-party analytics cookie in its
consent flow. It carries no PII and can't link across sites (the id is
first-party to whatever origin loads the tracker), but it does persist until
the visitor clears site data instead of expiring after a day.

The changeover was made with the table empty, so there are no hash-era rows left
to reason about. Anyone repeating it elsewhere should deploy the Worker *before*
running `pnpm db:schema`: the schema drops `salts`, and the old collector reads
it on every ingest, so the reverse order 500s every beacon until the Worker
lands.

## Time on page is not attention

Each pageview carries two clocks, because one number cannot be both.

`duration_ms` is **wall clock**: the timestamp of the last thing the tracker
recorded. A tab opened and left alone for four minutes reports four minutes.
That is exactly what episode chaining needs — it says when the pageview stopped
being touched — and a lie to show a human, who reads `⏱️ 3:35` as time spent.

`active_ms` is **attention**, and it is measured in the browser rather than
inferred later. Time accrues only while `document.visibilityState` is
`"visible"`, and only up to `ENGAGEMENT_GRACE_MS` (15s, `src/engagement.ts`)
past the last interaction. So a backgrounded tab is worth nothing however long
it sits, an abandoned but visible one is worth one grace period, and a page
someone is reading keeps counting through the stillness — including the stretch
after the last recorded event, which a wall clock throws away.

**Why the page has to be the one measuring.** The obvious alternative is to
reconstruct it on the server from the gaps between stored events. That was
tried, and it cannot see the two facts that actually decide the answer: whether
the tab was on screen at all, and whether a silence was a still read or an
abandoned tab. Both look identical in the event table. It also has to guess
short, because with no visibility signal a generous grace period would credit
backgrounded tabs — so it systematically under-reports real reading while still
over-reporting tabs nobody was looking at. Measuring in the page needs no guess
about either.

A keystroke pokes the engagement clock and does nothing else: no event, no key,
no target, no count leaves the page. Form input is never captured, by design and
by test — but filling in a form without touching the mouse is not an idle tab.

The column is **nullable on purpose**. `NULL` means "recorded by a tracker that
did not measure it" — everything written before the change, plus beacons from
pages still running a bundle cached before it — and `/api/sessions` answers
those by reconstructing a floor from the event gaps, capped at the short
`IDLE_GAP_MS` the replay uses, flagged as `active_estimated`, and shown in the
viewer with a `~`. A measured `0` is a real answer and stays one; a
`NOT NULL DEFAULT 0` would have collapsed the two.

## Add to a site

```html
<script async src="https://heatmap-analytics.asmyshlyaev177.workers.dev/tracker.js"></script>
```

That's the whole embed. The collector URL is baked into the bundle at build
time, and the site key — what keeps one site's data separate from another's —
is the page's own `location.hostname`.

The site key is deliberately *not* an attribute. A key passed in as markup is a
key anyone can copy: paste the snippet with someone else's key on an unrelated
host and its traffic lands in their heatmaps. Read off the hostname, a stray
embed can only ever file under its own host, where it is obvious and easy to
drop. That's hygiene, not enforcement — `/collect` is unauthenticated, so a
hand-rolled POST can still claim any key. `ALLOWED_SITES` is the enforcing half.

`data-endpoint` still overrides the baked-in collector, which is how the e2e
suite points each test at its own stub.

Override the baked-in value with `HM_ENDPOINT` at build time:

```bash
HM_ENDPOINT=https://my-collector.example pnpm build
```

`pnpm test:e2e` builds with it empty, so a test can never post to the live
collector — the tracker stays inert unless the page supplies `data-endpoint`.
The build prints the endpoint it baked in, because a bundle built with the
wrong one looks identical to a right one.

**Load it from the Worker, don't vendor a copy.** Serving `tracker.js` from the
collector is what keeps updates propagating on their own — `Cache-Control:
public, max-age=300`, so a redeploy reaches every site within five minutes. A
copy committed into a site's own `public/` needs a content hash in its query
string (static assets aren't fingerprinted by most frameworks) *and* a manual
re-sync on every tracker change, and a missed sync ships a stale tracker in
silence. That went wrong here once already.

React (TanStack Start, in the root document), gated the same way its GA4 tag
is — `react-horizontal-scrolling-menu.dev` runs it like this:

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

## View the data

Two surfaces, answering two different questions. The dashboard asks "what
happened anywhere"; the bookmarklet asks "what happened on the page I am
standing on", which is the only place a heatmap can be drawn.

### Dashboard

`https://heatmap-analytics.asmyshlyaev177.workers.dev/dashboard`

It asks for the `VIEWER_TOKEN` once and keeps it in that browser's
localStorage. `?t=<token>` works too and is taken back out of the address bar
as soon as it is read — a URL that keeps a credential gets bookmarked, pasted
into a chat and left in a history.

The row is a **visit**: one uninterrupted run of navigation, chained exactly
the way `/api/journey` chains it (the next page opening under
`NAV_CHAIN_GAP_MS` after the previous one's last activity). Not the pageview,
which is a fragment of what someone did, and not the visitor, whose id never
rotates. A visit of several pages expands into its legs, and any leg replays
from itself.

A row carries two badges, because it answers two questions. The tinted one is
the **visitor** — the id that persists, which is what makes a returning person
visible as one person; it reads `×3` when three of that visitor's visits are on
screen, and it takes its colour from the same hash the viewer uses, so a
visitor keeps their colour across both surfaces. The quiet one beside it is the
**visit**: the key `/api/journey` anchors on and the six characters the viewer
prints, with a visit's legs numbered `·1`, `·2` against it.

Filters: site, date range (local days, not UTC ones), a path search that
matches *any* leg of a visit, and a list of visitors to hide. Hiding is a view
preference stored per device, not a rule on the server: it drops the owner's
own browser out of the list without deleting a row, changing what `/collect`
accepts, or touching what the bookmarklet shows on the page itself.

The list is bounded. One call scans at most `REPLAYS_SCAN_CAP` pageviews and
says so when it hits that ceiling, and the scan reaches one episode window
*before* the range starts — a visit that began before midnight is still the
visit its rows belong to, and its first leg is the id a replay has to start
from.

### Replay deep links

▶ Replay opens the recorded page at `https://<site><path>#__hma=<ticket>`. The
tracker already on that page sees the fragment, loads the viewer with that
ticket, and records nothing for that page load — the owner watching a replay is
not a visit.

The ticket is why this is not just the bookmarklet with extra steps. The page a
replay runs on belongs to the tracked site, so whatever authorises the read is
readable by every script that site loads, and sits in its address bar besides.
So the link never carries `VIEWER_TOKEN`. A ticket is a random id, valid for
`TICKET_TTL_MS` (10 minutes), that can read **one visitor's recordings on one
site** and nothing else: `/api/journey` refuses another `sid`, `/api/replay`
checks the pageview it was handed actually belongs to that visitor, and every
aggregate endpoint answers 403. Expired tickets are swept by the nightly cron.

The panel that comes up is the whole panel — the heatmap and top-element views
are there and say what a link cannot reach if you click them. Load the
bookmarklet on the same page for those.

### Bookmarklet

Token lives in `.dev.vars`, gitignored — never commit it:

```text
javascript:(function(){var s=document.createElement('script');s.src='https://heatmap-analytics.asmyshlyaev177.workers.dev/viewer.js?t=<VIEWER_TOKEN>';document.body.appendChild(s)})()
```

Open any tracked page, hit the bookmarklet, pick a view. No site parameter: the
viewer falls back to `location.hostname`, which is the same key the tracker
filed the data under. Append `&site=<SITE>` only to read one site's data while
standing on a different page.

Each row in the replay list carries a chip reading `4934f7·3` — six characters
of the **visit** (keyed by the pageview that opened the episode) and this row's
**leg** within it — tinted by the **visitor**. The shared prefix groups the rows
one click replays together, the suffix tells one row from the next, and the
colour links a returning person's separate visits. Legs number over the whole
journey while the list is filtered to one path, so they arrive non-contiguous
(1, 3, 5) when a visitor kept coming back to this page. Full ids are on the
tooltip.

The visitor id alone was the obvious first choice and the wrong one, which is
worth recording: it never rotates, so on a site whose owner is also its main
visitor every row carried the same six characters and the chip said nothing. The replay
timeline is a permanent fixture of the panel rather than something a replay
adds and removes — starting or stopping one can't resize the panel under the
cursor, and a finished journey leaves its shape (where the clicks were, how
much of it was idle) on screen to read afterwards.

Replay positions the cursor **element-first** (recorded selector + relative
offset resolved against the live page), so it stays accurate across viewport
sizes and layout changes; raw scaled coordinates are only the fallback for
selectors that no longer exist.

Replay also **re-fires recorded clicks on safe UI-state controls** — buttons
(non-submit), `[role=button]`, `summary`, `[aria-haspopup]`,
`[aria-expanded]` — so modals, menus and accordions open mid-replay exactly as
they did for the visitor. Links and forms are never synthesized (navigation is
handled by journey legs; forms could fire real requests). Mark custom
clickables with `data-hm-replay` to opt in, or any subtree with
`data-hm-static` to opt out.

## API

All read endpoints require `?t=<VIEWER_TOKEN>`. The two marked ⊙ also accept
`?tk=<ticket>` instead, scoped to that ticket's visitor and site; everything
else answers 403 to a ticket.

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
pnpm deploy           # build + wrangler deploy
pnpm db:schema        # apply schema.sql to remote D1 (fresh database)
pnpm db:migrate       # apply one migrations/*.sql file to remote D1:
                      #   pnpm db:migrate --file=migrations/001-active-ms.sql
pnpm dev              # wrangler dev (uses .dev.vars for VIEWER_TOKEN)
pnpm test             # unit tests, then Playwright e2e
pnpm test:unit        # node:test against a fake D1 (fast, no network)
pnpm test:e2e         # build + Playwright (real tracker/viewer in Chromium)
pnpm typecheck        # tsc --noEmit
```

The tracker and the viewer are two esbuild IIFE bundles inlined into the Worker
as text. The dashboard is a page, so it is built like one: Vite resolves it,
Tailwind compiles the utilities its markup actually uses, Preact renders it, and
`vite-plugin-singlefile` folds script and styles back into a single document
(`vite.config.ts`). The Worker serves that document from one text import — no
second route to keep in step, and no asset that can 404 out from under the page
after a redeploy.

### Schema changes

`schema.sql` is the shape of a *fresh* database. Every statement in it is
`IF NOT EXISTS`, so running it against an existing one is a no-op that cannot
add a column — which is the point: it must be safe to re-run, and it must never
silently rewrite live data.

An existing database is brought up to that shape by a numbered file in
`migrations/`, applied once, by hand:

```bash
pnpm db:migrate --file=migrations/001-active-ms.sql
pnpm db:migrate --file=migrations/002-replay-tickets.sql
```

Both halves of a change land: the migration for databases that exist, the same
statement in `schema.sql` for ones that do not. Re-running 001 errors on the
duplicate column, which is the intended signal that it already landed; 002 adds
a whole table, so it is `IF NOT EXISTS` and re-running it is a no-op.

Order matters the same way it did for the `salts` removal — apply the migration
*before* deploying a Worker that writes the new column, or every beacon 500s on
`no such column` until the migration lands.

002 is gentler about it: ingest and every token-authenticated read work
perfectly well without `replay_tickets`. What breaks is minting a replay link
(a 500), and the tail of the nightly purge — the two retention deletes run
first, so data still ages out, but the cron ends on an error. Apply it first
anyway.

## Budget (D1 free tier)

Free tier allows 100k rows written/day. An engaged 2-minute visit writes
roughly 300–800 event rows; a typical short landing-page visit far fewer.
That's comfortably hundreds of engaged sessions/day across all sites. If it
ever gets tight: raise `SAMPLE_MS`, lower `MAX_EVENTS`, or reduce
`RETENTION_DAYS` (storage is 5GB).

## Config

- `VIEWER_TOKEN` (secret) — `wrangler secret put VIEWER_TOKEN`; also in
  `.dev.vars` for local dev.
- `ALLOWED_SITES` (var, optional) — comma-separated allowlist of site keys
  (hostnames) for `/collect`; unset accepts any. This is what actually stops a
  forged beacon filing under one of your sites.
- `RETENTION_DAYS` (var) — nightly purge horizon, default 30.

## Tests

Nothing in the suite touches the deployed Worker or the real D1.

**Unit** (`test/`, `pnpm test:unit`) — `node:test` running the TypeScript
sources directly via Node's type stripping. `test/helpers/fake-d1.ts` stands in
for D1: same `prepare/bind/all/run/batch` surface over `node:sqlite`, applying
the real `schema.sql`, so the SQL under test is executed by the same engine D1
runs — and D1's 100-bound-parameter ceiling is asserted, so a regression that
widens the insert chunking fails here rather than in production. Note for
contributors: strip-only mode means local imports need explicit `.ts`
extensions and no constructor parameter properties.

**End-to-end** (`e2e/`, `pnpm test:e2e`) — Playwright drives the **real built
bundles**. `e2e/server.mjs` runs two origins: fixtures on one port, a stub
collector on another (serving `dist/tracker.js` + `dist/viewer.js`, recording
every beacon for assertions at `/__beacons`). Separate origins on purpose —
that exercises the cross-origin `text/plain` beacon path that avoids a CORS
preflight. Ports come from `PAGES_PORT`/`COLLECTOR_PORT` so suites can run
concurrently without sharing recorded state. Viewer specs mock the read API
with `page.route`, so heatmap/replay rendering is tested against fixed data.

The fixtures neutralise `navigator.webdriver` (the tracker ignores automated
browsers by design); the guard itself is covered by a spec that loads with
`?keep-webdriver=1` and asserts silence.

`e2e/specs/dashboard.spec.ts` drives the built `dist/dashboard/dashboard.html`
— the same document the Worker embeds, so what is under test is the artifact
and not a second copy of the markup. `window.open` is stubbed there: a replay
link must never be followed to a live site from a test.

What the suite protects, beyond the obvious paths: the identity model (one
`localStorage` key and nothing else touched, the id generated once and reused
across pageviews and reloads, a corrupted stored value re-minted instead of
forwarded, blocked storage falling back rather than failing, both ends still
sharing one definition of the id's shape, the key name pinned so a rename can't
silently orphan every stored id, raw IP/UA never persisted), that form input is
never captured, idempotent ingest, journey chaining by navigation continuity,
journey windows that keep the requested pageview inside a capped response even
for a session far past that cap, idle compression, rage detection firing exactly
once, token-gated reads, and replay's element-anchored cursor staying correct
across viewport sizes.

For the dashboard and its deep links: visits chained the same way journeys are
(and never across two sites sharing a visitor id), a visit that straddles the
start of the range keeping its real first leg, a hidden id that is empty or
malformed being dropped rather than turned into a `NOT IN` that matches
nothing, engaged time reported as measured or flagged as a floor, a deep link
recording nothing on the page it opens, and a ticket refusing every read
outside the one visitor and site it was minted for.

`e2e/test-page.html` predates the suite and is kept for manual poking against
the deployed Worker: open it, interact, then check
`/api/sessions?site=e2e&...`. On `file://` pages `path` is the full filesystem
path.

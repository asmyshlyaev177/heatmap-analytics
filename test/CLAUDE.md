# Tests

Nothing in either suite touches the deployed Worker or the real D1.

```bash
pnpm test:unit   # node:test against a fake D1 — fast, no network
pnpm test:e2e    # build + Playwright, real bundles in Chromium
pnpm test        # both
```

## Unit (`test/`)

`node:test` running the TypeScript sources directly through Node's type
stripping. Strip-only mode means **local imports need explicit `.ts` extensions**
and no constructor parameter properties.

`helpers/fake-d1.ts` stands in for D1: the same `prepare/bind/all/run/batch`
surface over `node:sqlite`, applying the real `schema.sql`, so the SQL under test
runs on the same engine D1 does. D1's 100-bound-parameter ceiling is asserted
there, so a regression that widens the insert chunking fails here rather than in
production.

`worker.test.ts` registers a resolver hook, because `worker.ts` is written for
esbuild: the bundles arrive as `*.txt` text imports and its own modules resolve
through a folder's `index.ts`. Node does neither.

## End-to-end (`e2e/`)

Playwright drives the **real built bundles**. `e2e/server.mjs` runs two origins:
fixtures on one port, a stub collector on another (serving `dist/tracker.js` and
`dist/viewer.js`, recording every beacon at `/__beacons`). Separate origins on
purpose — that is the cross-origin `text/plain` beacon path that avoids a CORS
preflight.

Ports come from `PAGES_PORT`/`COLLECTOR_PORT`, so suites can run concurrently
without sharing recorded state. With neither set, a pair is derived from the pid
rather than defaulting to a fixed one.

Viewer specs mock the read API with `page.route`, so rendering is tested against
fixed data. `dashboard.spec.ts` drives the built document the Worker embeds, with
`window.open` stubbed — a replay link must never be followed to a live site from
a test.

The fixtures neutralise `navigator.webdriver`, since the tracker ignores
automated browsers by design; the guard itself has a spec that loads with
`?keep-webdriver=1` and asserts silence.

## What the suites protect

Beyond the obvious paths:

- **Identity** — one `localStorage` key and nothing else touched; the id
  generated once and reused across pageviews and reloads; a corrupted stored
  value re-minted rather than forwarded; blocked storage falling back rather than
  failing; both ends still sharing one definition of the id's shape; the key name
  pinned so a rename cannot silently orphan every stored id; raw IP and
  User-Agent never persisted.
- **Ingest** — form input never captured, idempotent re-sends, journey chaining
  by navigation continuity, journey windows keeping the requested pageview inside
  a capped response even for a session far past that cap.
- **Measurement** — idle compression, rage firing exactly once, engaged time
  reported as measured or flagged as a floor.
- **Reads** — token-gated endpoints, a ticket refusing every read outside the one
  visitor and site it was minted for, a deep link recording nothing on the page
  it opens.
- **The dashboard** — visits chained the way journeys are and never across two
  sites sharing a visitor id, a visit straddling the start of the range keeping
  its real first leg, a hidden id that is empty or malformed dropped rather than
  turned into a `NOT IN` that matches nothing, a placed visit drawing its flag
  and an unplaced one drawing nothing.
- **Replay** — the element-anchored cursor staying correct across viewport sizes,
  and the panel exactly as tall before, during and after.

## Manual

`e2e/test-page.html` predates the suite and is kept for poking at the deployed
Worker by hand: open it, interact, then read
`/api/sessions?site=e2e&...`. On `file://` pages `path` is the full filesystem
path.

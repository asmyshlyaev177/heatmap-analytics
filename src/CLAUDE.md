# src/

Four surfaces and the vocabulary they share. Each folder has its own
`CLAUDE.md` with the reasoning that belongs to it; this file is the map.

```text
worker.ts        routing only — every branch is one line to a handler in api/
api/             the collector (/collect) and every read endpoint
tracker/         what runs on a tracked page, ~1.7KB gzipped
viewer/          the bookmarklet overlay: heatmaps, top elements, replay
dashboard/       the owner's console at /dashboard, a Preact page
shared/          constants and formats both ends must agree on
generated/       build output, gitignored — the three bundles as text
```

Each folder resolves through an `index.ts`, so a cross-folder import is
`from "../shared"` and never a path into someone's internals.

## How they fit

The tracker posts beacons to `api/`, which writes D1. The viewer and the
dashboard read back through the token-gated endpoints in the same file. The
Worker serves all three bundles from `generated/*.txt`, inlined as text at build
time — one deploy, no second route, no asset that can 404 after a redeploy.

The viewer and the dashboard answer different questions and are not two views of
one thing. The viewer asks "what happened on the page I am standing on", which is
the only place a heatmap can be drawn; the dashboard asks "what happened
anywhere", which cannot draw one at all.

## Why `shared/` exists

`sid`, `timeline`, `engagement` and `fmt` are read by both a browser bundle and
the Worker, and every one of them is a place where two copies would drift
silently rather than loudly. `shared/CLAUDE.md` has the specifics; a unit test
asserts the tracker does not restate the id shape.

## Build

`scripts/build.mjs` makes three artifacts. The tracker and viewer are esbuild
IIFE bundles — not pages, so no page build. The dashboard is a page, so Vite
builds it and `vite-plugin-singlefile` folds script and styles into one
document (`vite.config.ts`). All three land in `generated/` as `.txt`, which
`wrangler.toml` declares as a Text module so `worker.ts` can import them.

`__HM_ENDPOINT__` is baked into the tracker at build time. The e2e build sets it
empty, which leaves the tracker inert unless a page passes `data-endpoint` — so
a test can never post to the live collector.

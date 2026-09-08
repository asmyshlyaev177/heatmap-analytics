# src/tracker/

What runs on a tracked page. ~1.7KB gzipped, one `localStorage` key, no cookies.

## What it records

Clicks, pointer moves (150ms sampling), scroll depth, and rage clicks —
`RAGE_N` (3) clicks within `RAGE_PX` (30) inside a rolling `RAGE_MS` (900ms)
window, firing exactly once per burst (`rage.ts`).

Events are **element-anchored**: a selector plus a relative x/y within that
element, so heatmaps survive responsive breakpoints and content edits. Raw
viewport coordinates ride along only as the viewer's fallback.

Batches flush through one `sendBeacon` as `text/plain`, which is what avoids a
CORS preflight; a failed beacon retries via `fetch` with `keepalive`, and the
unique `(pv, seq)` index makes the re-send idempotent rather than duplicating.

## What it never records

Form input. A keystroke pokes the engagement clock and does nothing else — no
event, no key, no target, no count leaves the page. Filling in a form without
touching the mouse is not an idle tab, which is the only reason keys are
observed at all. Asserted by an e2e spec.

## Engagement

Time accrues only while `document.visibilityState` is `"visible"`, and only up to
`ENGAGEMENT_GRACE_MS` (15s, `../shared`) past the last interaction. So a
backgrounded tab is worth nothing however long it sits, an abandoned but visible
one is worth one grace period, and a page someone is reading keeps counting
through the stillness — including the stretch after the last recorded event,
which a wall clock throws away.

Measuring here rather than on the server is load-bearing; `../api/CLAUDE.md` has
why the reconstruction cannot work.

## The site key

`location.hostname`, deliberately not an attribute. A key passed in as markup is
a key anyone can copy: paste the snippet with someone else's key on an unrelated
host and its traffic lands in their heatmaps. Read off the hostname, a stray
embed can only file under its own host, where it is obvious and easy to drop.

That is hygiene, not enforcement — `/collect` is unauthenticated. `ALLOWED_SITES`
is the enforcing half.

## Automation

Skips `navigator.webdriver` browsers, so Playwright and Lighthouse runs never
pollute the data. The e2e fixtures neutralise the flag to test anything at all;
one spec loads with `?keep-webdriver=1` and asserts silence.

## Deep links

A `#__hma=<ticket>` fragment makes the tracker load the viewer with that ticket
and record **nothing** for that page load — the owner watching a replay is not a
visit.

## Endpoint

`__HM_ENDPOINT__` is baked in at build time; `data-endpoint` on the script tag
overrides it, which is how the e2e suite points each test at its own stub.

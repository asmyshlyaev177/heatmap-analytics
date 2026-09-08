# src/api/

The collector and every read endpoint. Separated from `worker.ts` so tests can
import it without the bundled `*.txt` text assets, which only a bundler resolves.

## Sessions

`session_id` is a random UUID the browser mints once and keeps under `hma_sid`
in `localStorage`. The collector derives no part of it — no IP, no User-Agent,
no hash, no salt table — and treats it as opaque apart from pinning its shape
(`SID_RE`, from `../shared`). An unauthenticated beacon must not be able to put
arbitrary text in a column the viewer sends back out as a query parameter. A
value that fails is replaced by a throwaway id, so a malformed beacon still
records but does not join anyone else's session.

**A visitor is not a visit.** The id never rotates, so it identifies a visitor
and cannot group a replay list. Pageviews chain into an *episode* instead: each
starting under `NAV_CHAIN_GAP_MS` (30s) after the previous one's last recorded
activity, which is what a navigation looks like. Both reads are capped because a
permanent id has no bound on how many rows it accumulates — `/api/journey` takes
at most 200 rows and returns at most 50, windowed so the requested pageview is
always inside; `/api/sessions` looks ±6h for episode siblings.

**Why it changed.** This was a Plausible/Fathom-style server-side hash,
`sha256(daily_salt | site | ip | user_agent)[:32]`, rotated daily out of a
`salts` table. Nothing was stored on the device, but the identity was really
"network + browser", wrong in both directions: a phone moving from wifi to
mobile data became two visitors, two people behind one office NAT on the same
browser version became one. A client-side id is exact on both, and journeys stop
breaking at UTC midnight.

**What it costs.** A `localStorage` identifier is storage on the device under
ePrivacy, so this is not the consent-free posture the hash had — an EU-facing
site should treat it like a first-party analytics cookie. It carries no PII and
cannot link across sites, but it persists until the visitor clears site data.

## Country

`country()` reads `CF-IPCountry` and nothing else. Cloudflare geolocates the
connecting address at the edge, before the Worker runs; the address itself is
never read here and never stored. Re-checked against `/^[A-Z]{2}$/`, because a
header is a header.

Where the tracked site is hosted has nothing to do with it — the beacon is a
cross-origin POST from the visitor's browser straight to the Worker, so a page
served from Vercel or a static bucket still reaches Cloudflare's edge with the
visitor's own address. What matters is that the *collector* is a Worker.

`NULL` is a real answer: `wrangler dev` without `--remote`, the e2e build's
same-origin endpoint, Cloudflare's `XX` for an address it cannot place, and Tor's
`T1`, which the shape check drops on its way past. Moving off Cloudflare is a
one-string change (Vercel `x-vercel-ip-country`, CloudFront
`CloudFront-Viewer-Country`, Fly `Fly-Client-Country`) — except Netlify, whose
`x-nf-geo` is base64 JSON and needs a decode.

Written on insert, never on a later flush's upsert, the way `session_id` is: a
visit is placed where it opened, so a VPN flipped mid-read cannot move it. A
visit's country is its entry leg's.

A country is coarse enough not to identify anyone alone, but it is inferred from
the visitor's address — a privacy notice that enumerates what is collected
should name it.

## Two clocks

`duration_ms` is **wall clock**: the timestamp of the last thing recorded. A tab
left alone for four minutes reports four minutes. Exactly what episode chaining
needs, and a lie to show a human who reads `⏱️ 3:35` as time spent.

`active_ms` is **attention**, measured in the browser (see `../tracker`). The
server cannot reconstruct it: whether the tab was on screen, and whether a
silence was a still read or an abandoned tab, look identical in the event table.
A reconstruction also has to guess short — with no visibility signal a generous
grace would credit backgrounded tabs — so it under-reports real reading while
over-reporting tabs nobody watched.

The column is **nullable on purpose**. `NULL` is "recorded by a tracker that did
not measure it", answered by reconstructing a floor from event gaps capped at
`IDLE_GAP_MS`, flagged `active_estimated` and shown with a `~`. A measured `0` is
a real answer; `NOT NULL DEFAULT 0` would collapse the two.

## Replay tickets

A replay runs on the recorded page, which is not the owner's origin — whatever
authorises the read is readable by every script that site loads and sits in its
address bar. So never `VIEWER_TOKEN`. A ticket is a random id valid for
`TICKET_TTL_MS` (10 min) that can read one visitor's recordings on one site:
`/api/journey` refuses another `sid`, `/api/replay` checks the pageview belongs
to that visitor, every aggregate endpoint answers 403. Swept by the nightly cron.

Not single-use — one replay is many reads (the journey, then each leg) — so the
bound is time and scope, not count.

`apiReplay` names its columns rather than `SELECT *`, because that endpoint is
ticket-reachable: a column added to `pageviews` must be a decision, not
disclosure by default.

## Trust boundaries

- **`isSafePath`** — the viewer assigns `path` to a same-origin iframe `src`, so
  a stored `javascript:`, `data:` or `//evil.com` would run in the *owner's*
  origin. Refused, not normalised.
- **`startedAt`** — retention is measured against it, so an implausible claim is
  replaced by the receive time rather than clamped.
- **`/collect` is unauthenticated**, so a hand-rolled POST can claim any site
  key. `ALLOWED_SITES` is the enforcing half; reading the key off
  `location.hostname` is only hygiene.

## Bounds

`REPLAYS_SCAN_CAP` (2000) pageviews per `/api/replays` call, reported as
`truncated`. `MAX_EXCLUSIONS` (40) and `STATS_CHUNK` (80) keep statements under
D1's 100-bound-parameter ceiling — `test/helpers/fake-d1.ts` asserts it.

`purge()` runs nightly (`0 4 * * *`), deleting events and pageviews past
`RETENTION_DAYS` and expired tickets. There is no `VACUUM`: free pages are reused
by the next day's inserts, so the file sits at steady state.

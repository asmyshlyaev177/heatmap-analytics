# src/dashboard/

The owner's console at `/dashboard`: every visit on every connected site, and one
click to replay it on the page it was recorded on. Preact, Tailwind, one
document.

```text
index.tsx        the page
dashboard.css    Tailwind source + the viewer's palette as theme tokens
dashboard.html   the shell Vite resolves
```

## One document

Vite builds it and `vite-plugin-singlefile` folds script and styles back in, so
the Worker serves it from a single text import. No second route to keep in step,
no asset that can 404 out from under the page after a redeploy — and the e2e
suite drives the very same `dist/dashboard/dashboard.html` the Worker embeds,
so what is under test is the artifact rather than a second copy of the markup.

`dashboard.css` pins the Tailwind scanner with `source(none)` plus two `@source`
lines. Left to walk the repository it would find the tracker and viewer bundles,
which are full of strings that look like class names.

The palette is the viewer's, as theme tokens: two surfaces showing the same data
should not disagree about what it looks like. Dark only, deliberately — this is
a console for reading recordings, not a public page.

## The row is a visit

One uninterrupted run of navigation, chained exactly the way `/api/journey`
chains it. Not the pageview, which is a fragment of what someone did, and not the
visitor, whose id never rotates. A multi-page visit expands into its legs, and
any leg replays from itself.

**Two badges, because a row answers two questions.** The tinted one is the
visitor — the id that persists, reading `×3` when three of that visitor's visits
are on screen, taking its colour from the hash the viewer uses, so a visitor
keeps their colour across both surfaces. The quiet one is the visit: the key
`/api/journey` anchors on and the six characters the viewer prints.

Beside them, a country flag when the edge placed the visit. A regional-indicator
pair — platforms with no flag glyphs (Windows) draw the two letters instead,
which is why no code is printed next to it.

## Filters

Site, date range (**local** days, not UTC — "today" means the owner's today),
a path search matching *any* leg of a visit, and a list of visitors to hide.

Hiding is a view preference stored per device, not a rule on the server: it drops
the owner's own browser out of the list without deleting a row, changing what
`/collect` accepts, or touching what the bookmarklet shows on the page itself.

## The token

Asked for once and kept in this browser's `localStorage`. `?t=<token>` works and
is taken back out of the address bar as soon as it is read — a URL that keeps a
credential gets bookmarked, pasted into a chat and left in a history.

A rejected token is not a per-request error; it puts the whole page back behind
the gate, so it has its own type rather than painting "Error: unauthorized" over
the message the gate just showed.

## Headers

No CORS header — nothing should fetch this cross-origin. `X-Frame-Options: DENY`,
because it must not be framed by any of the sites it reports on. Never cached.

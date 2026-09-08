# src/viewer/

The bookmarklet overlay, drawn on the live page: click heatmap (red rings on
rage points), hover heatmap, top-elements list, and session replay. Loaded by
the tracker on a `#__hma=<ticket>` deep link, or pasted in by hand with a token.

This is the only surface where a heatmap can be drawn at all — it needs the
current DOM to resolve selectors against.

## Element-first positioning

Stored selector plus relative offset, resolved against the live page, so points
stay accurate across viewport sizes and layout changes. Raw scaled coordinates
are the fallback only for selectors that no longer exist.

## Replay re-fires some clicks

Buttons (non-submit), `[role=button]`, `summary`, `[aria-haspopup]`,
`[aria-expanded]` — so modals, menus and accordions open mid-replay exactly as
they did for the visitor. Links and forms are **never** synthesized: navigation
is what journey legs are for, and a form could fire a real request. Opt in with
`data-hm-replay`, opt a subtree out with `data-hm-static`.

## Row chips

`4934f7·3` — six characters of the **visit** (keyed by the pageview that opened
the episode) and this row's **leg** within it, tinted by the **visitor**. The
shared prefix groups the rows one click replays together, the suffix separates
them, the colour links a returning person's visits.

Legs number over the whole journey while the list is filtered to one path, so
they arrive non-contiguous (1, 3, 5) when a visitor kept coming back.

The visitor id alone was the obvious first choice and the wrong one: it never
rotates, so on a site whose owner is also its main visitor every row carried the
same six characters and the chip said nothing.

## The panel does not resize

The replay timeline is a permanent fixture, not something a replay adds and
removes. Starting or stopping one must not move the panel under the cursor, and a
finished journey leaves its shape — where the clicks were, how much was idle — on
screen to read afterwards. An e2e spec measures the height before, during and
after.

## Ticket scope

On a deep link the panel is still the whole panel; the heatmap and top-element
views say what a ticket cannot reach if you open them. A ticket reads one
visitor on one site — `../api/CLAUDE.md` has why.

## Caching

Served `no-cache`, unlike `tracker.js` — a stale cached viewer hides a redeploy
from the one person who would notice.

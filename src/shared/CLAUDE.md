# src/shared/

Four modules that a browser bundle and the Worker both read. They live here
because each one is a place where two copies would disagree *silently*.

`index.ts` re-exports all of them, so a consumer writes `from "../shared"` and
cannot reach a second definition by importing a different path.

## sid.ts

`SID_RE` and `SID_KEY`. The tracker validates what it reads back out of
`localStorage`; the collector validates what arrives on a beacon. If the shapes
disagreed the tracker would forward ids the collector refuses — and a refused id
is replaced by a throwaway, so every journey would stop chaining with nothing
logged anywhere.

`test/session-id.test.ts` reads `src/tracker/index.ts` and fails if it restates
the pattern instead of importing it.

## engagement.ts

`ENGAGEMENT_GRACE_MS` (15s): how long after the last interaction a *visible* tab
still counts as attention. The tracker measures against it; the collector
reconstructs a floor with it for pageviews recorded before the tracker measured
anything.

Not `IDLE_GAP_MS`. That one is 4s and governs playback, not measurement.

## timeline.ts

`IDLE_GAP_MS`, `IDLE_KEEP_MS` and `compressTimeline`. One definition of "idle",
so the session list and the replay agree: `Σ min(gap, IDLE_GAP_MS) + Σ max(gap −
IDLE_GAP_MS, 0)` is exactly the wall clock. "0:39 active" in the list and the
idle the replay says it skipped add up instead of contradicting each other.

## fmt.ts

How a visit is written down — six characters, a hue, a clock. Shared by the
viewer and the dashboard because a visit that appears in both has to look the
same in both, or the two lists read as different data.

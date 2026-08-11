// How long after the last interaction a *visible* tab still counts as
// attention. Shared by the tracker, which measures engaged time against it,
// and by the collector, which reconstructs a floor for pageviews recorded
// before the tracker measured anything.
//
// 15s is generous on purpose, and affordable because the tracker only ever
// counts while document.visibilityState is "visible": a page nobody is looking
// at contributes nothing however long it sits, so the grace only has to cover
// a still read on a page someone has in front of them. A paragraph takes
// longer than a mouse twitch.
//
// Not to be confused with IDLE_GAP_MS in timeline.ts, which answers a
// different question — how long a stretch of a *recording* has to be before
// playing it back in full is a waste of the viewer's time. That one is short
// (4s) because it governs playback, not measurement.
export const ENGAGEMENT_GRACE_MS = 15_000;

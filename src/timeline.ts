// One definition of "idle", used at both ends of the product.
//
// The tracker records something on every click, on every scroll step and every
// 150ms the pointer moves, so a stretch longer than IDLE_GAP_MS with nothing in
// it is not attention — it is a tab someone left open. The replay plays such a
// stretch back as IDLE_KEEP_MS instead of stalling on it, and apiSessions
// leaves everything past IDLE_GAP_MS out of the active time it reports.
//
// Both ends reading the same number is what makes the session list and the
// replay agree: Σ min(gap, IDLE_GAP_MS) + Σ max(gap − IDLE_GAP_MS, 0) is
// exactly the wall clock, so "0:39 active" in the list and the idle the replay
// says it skipped add up instead of contradicting each other.
export const IDLE_GAP_MS = 4000;
export const IDLE_KEEP_MS = 1000;

// Idle compression for replay: any gap over gapMs with no recorded activity
// is represented as keepMs of virtual time. `skips` lists where the
// compressed stretches sit on the virtual timeline (for rendering) along
// with their real length.

export interface TimedEvent {
  t: number;
}

export interface TimelineSkip {
  vt: number;
  real: number;
}

export function compressTimeline<T extends TimedEvent>(
  events: T[],
  gapMs = IDLE_GAP_MS,
  keepMs = IDLE_KEEP_MS,
): { events: (T & { vt: number })[]; skips: TimelineSkip[]; vEnd: number } {
  const skips: TimelineSkip[] = [];
  let offset = 0;
  let prev = 0;
  const out = events.map((e) => {
    const gap = e.t - prev;
    if (gap > gapMs) {
      skips.push({ vt: prev - offset, real: gap });
      offset += gap - keepMs;
    }
    prev = e.t;
    return { ...e, vt: e.t - offset };
  });
  return {
    events: out,
    skips,
    vEnd: out.length ? Math.max(out[out.length - 1].vt, 400) : 400,
  };
}

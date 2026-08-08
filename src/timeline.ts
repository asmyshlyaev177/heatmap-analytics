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
  gapMs = 4000,
  keepMs = 1000,
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

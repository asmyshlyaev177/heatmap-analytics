// Rage click detection: RAGE_N+ clicks within RAGE_PX of each other inside a
// rolling RAGE_MS window. Fires exactly once per burst — when it reaches
// RAGE_N; further clicks extend the window without re-firing.

export interface BurstPoint {
  x: number;
  y: number;
  at: number;
}

export const RAGE_N = 3;
export const RAGE_MS = 900;
export const RAGE_PX = 30;

export function rageBurst(
  burst: BurstPoint[],
  p: BurstPoint,
): { burst: BurstPoint[]; rage: boolean } {
  const next = burst.filter(
    (b) => p.at - b.at < RAGE_MS && Math.hypot(b.x - p.x, b.y - p.y) < RAGE_PX,
  );
  next.push(p);
  return { burst: next, rage: next.length === RAGE_N };
}

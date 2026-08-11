// How a visit is written down, shared by the two surfaces that show one.
//
// The viewer lists the visits that touched the page it is standing on; the
// dashboard lists every visit on every site. A visit that appears in both has
// to look the same in both — same six characters, same colour, same clock —
// or the two lists read as different data.

export const fmtTime = (ms: number): string => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export const fmtAge = (ts: number, now = Date.now()): string => {
  const m = Math.round((now - ts) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};

// Six hex characters of a UUID collide at odds no page of rows will meet; the
// full id is always on the tooltip.
export const shortId = (s: string): string => s.replace(/-/g, "").slice(0, 6) || "??????";

// Stable colour per id. The chip's text is the *visit*, its colour is the
// *visitor* — that pairing is what makes a returning person's separate visits
// read as related without the id itself having to vary.
export const idHue = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
};

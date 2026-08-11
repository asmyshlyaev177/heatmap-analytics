import { render } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { fmtAge, fmtTime, idHue, shortId } from "./fmt";

// The owner's console: every visit on every connected site, filtered by date,
// minus the visitors being hidden — and a way to open any of them as a replay
// on the page it was recorded on.
//
// Served by the Worker itself, so every request is same-origin and relative: no
// endpoint is baked in, and the token never leaves this origin.
//
// Preact renders everything below, which is also what keeps the recorded data
// safe to show: site keys and paths arrive from an unauthenticated beacon, and
// JSX children are text, never markup.

const TOKEN_KEY = "hma_dash_token";
const HIDDEN_KEY = "hma_dash_hidden";
const PAGE = 25;
const DAY = 86_400_000;

export interface Leg {
  id: string;
  site: string;
  session_id: string;
  path: string;
  started_at: number;
  duration_ms: number;
  active_ms: number;
  active_estimated: number;
  clicks: number;
  rage: number;
  events: number;
  max_scroll: number;
}

export interface Visit {
  episode: string;
  site: string;
  session_id: string;
  started_at: number;
  ended_at: number;
  entry_path: string;
  pages: number;
  duration_ms: number;
  active_ms: number;
  active_estimated: number;
  clicks: number;
  rage: number;
  events: number;
  max_scroll: number;
  legs: Leg[];
}

interface SiteRow {
  site: string;
  pageviews: number;
  visitors: number;
  last_seen: number;
}

interface Hidden {
  sid: string;
  label: string;
  at: number;
}

interface Filters {
  site: string;
  range: string;
  from: string;
  to: string;
  q: string;
}

// ---------- storage ----------

const store = {
  get(key: string): string {
    try {
      return localStorage.getItem(key) ?? "";
    } catch {
      return "";
    }
  },
  set(key: string, value: string) {
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch {
      /* private mode — the session simply doesn't outlive the tab */
    }
  },
};

// ?t=<token> is accepted once and then taken out of the address bar: a
// dashboard URL that carries the token gets bookmarked, pasted into a chat and
// left in a history. localStorage on this origin is where it belongs.
const initialToken = (): string => {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get("t");
  if (!fromUrl) return store.get(TOKEN_KEY);
  store.set(TOKEN_KEY, fromUrl);
  params.delete("t");
  const qs = params.toString();
  history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : ""));
  return fromUrl;
};

// Hidden visitors live here rather than in the database, because this is a view
// preference: it keeps the owner's own browser (and anything else worth
// ignoring) out of this list without deleting a row, changing what /collect
// accepts, or touching what the bookmarklet shows on the page itself.
const readHidden = (): Hidden[] => {
  try {
    const raw: unknown = JSON.parse(store.get(HIDDEN_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((h): h is Hidden => !!h && typeof (h as Hidden).sid === "string")
      .map((h) => ({ sid: h.sid, label: String(h.label ?? ""), at: Number(h.at) || 0 }));
  } catch {
    return [];
  }
};

// ---------- api ----------

// A rejected token is not a per-request error: it puts the whole page back
// behind the gate. Its own type, so a caller reports that instead of painting
// "Error: unauthorized" over the message the gate just showed.
class Unauthorized extends Error {}

const call = async (
  token: string,
  path: string,
  params: Record<string, string> = {},
  method = "GET",
) => {
  const qs = new URLSearchParams({ ...params, t: token });
  const res = await fetch(`/api/${path}?${qs}`, { method });
  if (res.status === 401) throw new Unauthorized();
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
};

// ---------- date range ----------

const pad = (n: number) => String(n).padStart(2, "0");
const toDateInput = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// Date inputs are local days, not UTC ones: "today" has to mean the owner's
// today, and the API takes epoch ms, so the conversion happens exactly here.
const fromDateInput = (v: string, endOfDay = false) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return NaN;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (endOfDay) d.setDate(d.getDate() + 1);
  return d.getTime();
};

const resolveRange = (f: Filters): { from: number; to: number; label: string } => {
  const now = Date.now();
  if (f.range === "today") {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    return { from: midnight.getTime(), to: now + DAY, label: "today" };
  }
  if (f.range === "0") return { from: 0, to: now + DAY, label: "all time" };
  if (f.range === "custom") {
    const from = fromDateInput(f.from);
    const to = fromDateInput(f.to, true);
    return {
      from: Number.isFinite(from) ? from : 0,
      to: Number.isFinite(to) ? to : now + DAY,
      label: `${f.from || "…"} → ${f.to || "…"}`,
    };
  }
  const days = Number(f.range) || 7;
  return { from: now - days * DAY, to: now + DAY, label: `last ${days} days` };
};

// ---------- deep links ----------

// A site key is whatever a beacon claimed, so it is checked against the shape of
// a hostname before anything is opened with it: "evil.com@real.site" is a
// perfectly good TEXT column value and a completely different origin.
const HOSTNAME = /^[a-z0-9.-]{1,64}$/i;
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/i;
const safePath = (p: string) => /^\/($|[^/\\])/.test(p) && !/[\\\x00-\x1f\x7f]/.test(p);

const linkFor = (site: string, path: string, tk: string): string => {
  if (!HOSTNAME.test(site) || !safePath(path)) {
    throw new Error("Refusing to open a recorded location that is not a site and a path");
  }
  return `${LOCAL.test(site) ? "http" : "https"}://${site}${path}#__hma=${tk}`;
};

// ---------- presentation ----------

const CHIP =
  "shrink-0 rounded px-1.5 font-mono text-xs leading-[18px] font-semibold whitespace-nowrap";

const chipStyle = (sessionId: string) => {
  const hue = idHue(sessionId ?? "");
  return { background: `hsl(${hue} 42% 24%)`, color: `hsl(${hue} 72% 78%)` };
};

// A cell of numbers, right-aligned so digits line up down the column, and
// never wrapping — a table whose columns move as rows load is unreadable.
const NUM = "border-b border-line px-2 py-2 text-right tabular-nums whitespace-nowrap align-middle";
const CELL = "border-b border-line px-2 py-2 align-middle";

// The engaged clock, the same number the viewer shows. "~" marks a visit with a
// leg recorded before the tracker measured attention, where the number is a
// floor rebuilt from event gaps rather than something the page observed.
const activeText = (v: { active_ms: number; active_estimated: number }) =>
  `${v.active_estimated ? "~" : ""}${fmtTime(v.active_ms)}`;

// Two badges, because a row answers two questions and one badge cannot.
//
// The visitor badge is the id that persists: it is what makes a returning
// person visible as one person, so it carries the count of that visitor's other
// visits on screen and the colour hash the viewer uses for the same id.
//
// The visit badge is this visit — the key /api/journey anchors on, the six
// characters the viewer prints on the rows one click replays together, and what
// a leg numbers itself against. Deliberately quiet: it identifies a row, it
// does not group anything.
function VisitorBadge({ visit, repeat }: { visit: Visit; repeat: number }) {
  return (
    <span
      class={CHIP}
      style={chipStyle(visit.session_id)}
      title={
        `visitor ${visit.session_id}` +
        (repeat > 1 ? `\n${repeat} visits by this visitor in this list` : "")
      }
    >
      {shortId(visit.session_id)}
      {repeat > 1 && ` ×${repeat}`}
    </span>
  );
}

function VisitBadge({ visit, leg = 0 }: { visit: Visit; leg?: number }) {
  return (
    <span
      class={`${CHIP} border border-line text-dim`}
      title={`visit ${visit.episode}${leg ? `\npage ${leg} of ${visit.pages}` : ""}`}
    >
      {shortId(visit.episode)}
      {leg ? `·${leg}` : ""}
    </span>
  );
}

function VisitRow({
  visit,
  repeat,
  onReplay,
  onCopy,
  onHide,
}: {
  visit: Visit;
  repeat: number;
  onReplay: (pv: string) => void;
  onCopy: (pv: string) => void;
  onHide: (visit: Visit) => void;
}) {
  const [open, setOpen] = useState(false);
  // One <tbody> per visit rather than one <tr>: it keeps a visit's legs inside
  // the element that is the visit, and it is what lets the expanded rows sit in
  // the same table without breaking the column tracks.
  return (
    <tbody data-episode={visit.episode} class="transition-colors hover:bg-panel2">
      <tr>
        <td class={CELL}>
          <VisitorBadge visit={visit} repeat={repeat} />
        </td>
        <td class={CELL}>
          <VisitBadge visit={visit} />
        </td>
        {/* w-full + max-w-0: in a table this cell takes every pixel the fixed
            columns do not, and truncates inside it instead of widening them */}
        <td class={`${CELL} w-full max-w-0`}>
          <div class="truncate">
            <span class="text-accent-ink">{visit.site}</span>{" "}
            <span class="text-dim2">{visit.entry_path}</span>
          </div>
        </td>
        <td class={NUM}>{visit.pages}</td>
        <td class={NUM} title={`${fmtTime(visit.duration_ms)} from first to last activity`}>
          {activeText(visit)}
        </td>
        <td class={NUM}>{visit.clicks}</td>
        <td class={`${NUM} ${visit.rage ? "text-warn" : "text-dim"}`}>{visit.rage || "–"}</td>
        <td class={NUM}>{visit.max_scroll}%</td>
        <td
          class={`${NUM} text-dim`}
          title={
            `${new Date(visit.started_at).toLocaleString()}\n` +
            `${visit.pages} page${visit.pages === 1 ? "" : "s"} · ${visit.events} events\n` +
            `${fmtTime(visit.duration_ms)} from first to last activity, ` +
            `${activeText(visit)} of it engaged\n` +
            `visitor ${visit.session_id}`
          }
        >
          {fmtAge(visit.started_at)}
        </td>
        <td class={`${CELL} whitespace-nowrap`}>
          <div class="flex items-center justify-end gap-1.5">
            <button
              type="button"
              class="hma-btn hma-btn-primary"
              title="Open the recorded page and play this visit"
              onClick={() => onReplay(visit.episode)}
            >
              ▶ Replay
            </button>
            <button
              type="button"
              class="hma-btn"
              title="Copy a replay link"
              onClick={() => onCopy(visit.episode)}
            >
              ⧉
            </button>
            <button
              type="button"
              class="hma-btn"
              title="Hide this visitor from the list"
              onClick={() => onHide(visit)}
            >
              🚫
            </button>
            <button
              type="button"
              class={`hma-btn ${visit.pages > 1 ? "" : "invisible"}`}
              title={`Show the ${visit.pages} pages of this visit`}
              aria-expanded={open}
              disabled={visit.pages < 2}
              onClick={() => setOpen(!open)}
            >
              {open ? "⌃" : "⌄"}
            </button>
          </div>
        </td>
      </tr>

      {visit.pages > 1 && open && (
        <tr>
          <td class={`${CELL} pt-0`} colSpan={COLUMNS.length}>
            <ul class="ml-1 list-none border-l-2 border-line pl-3">
              {visit.legs.map((leg, i) => (
                <li key={leg.id} class="flex flex-wrap items-center gap-2 py-1">
                  <VisitBadge visit={visit} leg={i + 1} />
                  <span class="min-w-0 flex-1 truncate text-dim2">{leg.path}</span>
                  <span class="whitespace-nowrap text-xs text-dim tabular-nums">
                    {`${activeText(leg)} · ${leg.clicks} clicks` +
                      (leg.rage ? ` · ${leg.rage} rage` : "")}
                  </span>
                  <button
                    type="button"
                    class="hma-btn"
                    title={`Replay from ${leg.path}`}
                    onClick={() => onReplay(leg.id)}
                  >
                    ▶
                  </button>
                </li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </tbody>
  );
}

// The columns, in order — one definition, used by the header, by the colSpan of
// an expanded visit's legs, and by nothing else. A header that can disagree
// with its rows is the whole reason a table drifts.
const COLUMNS: { label: string; title?: string; align?: "right"; grow?: true }[] = [
  { label: "Visitor", title: "The id this browser has kept since its first visit" },
  { label: "Visit", title: "This uninterrupted run of navigation" },
  { label: "Site / entry page", grow: true },
  { label: "Pages", title: "Pages in this visit", align: "right" },
  {
    label: "Active",
    title: "Engaged time: visible-tab time within 15s of an interaction. ~ means reconstructed",
    align: "right",
  },
  { label: "Clicks", align: "right" },
  { label: "Rage", title: "3+ clicks within 30px inside 900ms", align: "right" },
  { label: "Scroll", title: "Deepest scroll reached on any page of the visit", align: "right" },
  { label: "Started", align: "right" },
  { label: "", title: "" },
];

// One sentence, spaces and all — a row of flex children reads back as
// "2visits·3pages" to a screen reader and to anything that copies it, and the
// gap between them is only paint.
function Summary({
  visits,
  total,
  truncated,
  label,
  hiddenCount,
}: {
  visits: Visit[];
  total: number;
  truncated: boolean;
  label: string;
  hiddenCount: number;
}) {
  const pages = visits.reduce((n, v) => n + v.pages, 0);
  const visitors = new Set(visits.map((v) => v.session_id)).size;
  const count = (n: number, one: string, many: string) => (
    <>
      <b class="font-semibold text-ink">{n}</b> {n === 1 ? one : many}
    </>
  );
  return (
    <p id="summary" class="mb-3 text-dim">
      {count(total, "visit", "visits")} · {count(pages, "page", "pages")} ·{" "}
      {count(visitors, "visitor", "visitors")} · {label}
      {visits.length < total && ` · showing ${visits.length}`}
      {hiddenCount > 0 && ` · ${hiddenCount} hidden`}
      {truncated && (
        <span class="text-hot">
          {" "}
          · only the most recent pageviews in this range were scanned — narrow it
        </span>
      )}
    </p>
  );
}

function HiddenPanel({
  hidden,
  onShow,
  onAdd,
}: {
  hidden: Hidden[];
  onShow: (sid: string) => void;
  onAdd: (sid: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <section id="hidden-panel" class="mb-3 rounded-lg border border-line bg-panel p-3">
      <h2 class="mb-2 text-[13px] font-semibold text-dim">
        Hidden visitors — filtered out of this list, kept in the database
      </h2>
      {hidden.length === 0 ? (
        <p class="text-[13px] text-dim">
          Nothing hidden. Hide your own browser to keep it out of the list.
        </p>
      ) : (
        hidden.map((h) => (
          <div key={h.sid} class="flex items-center gap-2 py-0.5">
            <code
              class="min-w-0 flex-1 truncate font-mono text-xs text-dim2"
              title={h.label ? `${h.label} · hidden ${fmtAge(h.at)}` : `hidden ${fmtAge(h.at)}`}
            >
              {h.sid}
            </code>
            <button
              type="button"
              class="hma-btn"
              title="Stop hiding this visitor"
              onClick={() => onShow(h.sid)}
            >
              Show again
            </button>
          </div>
        ))
      )}
      <form
        id="add-hidden"
        class="mt-2 flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          const sid = value.trim();
          if (!sid) return;
          setValue("");
          onAdd(sid);
        }}
      >
        <input
          id="add-sid"
          class="hma-field flex-1"
          placeholder="session id"
          aria-label="Session id to hide"
          spellcheck={false}
          value={value}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
        />
        <button type="submit" class="hma-btn">
          Hide
        </button>
      </form>
    </section>
  );
}

function Gate({ onToken }: { onToken: (t: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div id="gate" class="mx-auto my-16 max-w-md rounded-xl border border-line bg-panel p-5">
      <h2 class="mb-1.5 text-[15px] font-semibold">Viewer token</h2>
      <p class="mb-3.5 text-[13px] text-dim">
        The same token the bookmarklet carries. It is kept in this browser's localStorage and sent
        only to this Worker.
      </p>
      <form
        id="gate-form"
        class="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onToken(value.trim());
        }}
      >
        <input
          id="gate-token"
          type="password"
          autocomplete="current-password"
          spellcheck={false}
          placeholder="VIEWER_TOKEN"
          aria-label="Viewer token"
          class="hma-field flex-1"
          value={value}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
        />
        <button type="submit" class="hma-btn hma-btn-primary">
          Open
        </button>
      </form>
    </div>
  );
}

function App() {
  const [token, setToken] = useState(initialToken);
  const [hidden, setHidden] = useState<Hidden[]>(readHidden);
  const [filters, setFilters] = useState<Filters>({
    site: "",
    range: "7",
    from: "",
    to: "",
    q: "",
  });
  const [search, setSearch] = useState("");
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [offset, setOffset] = useState(0);
  const [showHidden, setShowHidden] = useState(false);
  const [status, setStatus] = useState({ msg: "", error: false });
  const [nonce, setNonce] = useState(0);

  const say = useCallback((msg: string, error = false) => setStatus({ msg, error }), []);
  const excluded = hidden.map((h) => h.sid).join(",");
  // how many of a visitor's visits are on screen, so a returning person reads
  // as one at a glance instead of as unrelated rows that happen to share a hue
  const repeats = useMemo(() => {
    const seen = new Map<string, number>();
    for (const v of visits) seen.set(v.session_id, (seen.get(v.session_id) ?? 0) + 1);
    return seen;
  }, [visits]);
  const { from, to, label } = useMemo(() => resolveRange(filters), [filters]);

  // A rejected token drops the whole page back behind the gate; anything else
  // is one request's problem and goes on the status line.
  const report = useCallback(
    (err: unknown) => {
      if (err instanceof Unauthorized) {
        setToken("");
        store.set(TOKEN_KEY, "");
        say("That token was rejected — check VIEWER_TOKEN and try again", true);
      } else {
        say(String(err), true);
      }
    },
    [say],
  );

  const api = useCallback(
    (path: string, params: Record<string, string> = {}, method = "GET") =>
      call(token, path, params, method),
    [token],
  );

  // debounce the path box: one request per pause, not one per keystroke
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((f) => (f.q === search ? f : { ...f, q: search }));
      setOffset(0);
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (!token) return;
    let live = true;
    api("sites", { from: String(from), to: String(to) })
      .then((data: { sites: SiteRow[] }) => {
        if (!live) return;
        setSites(data.sites);
        // a site that dropped out of the range must not silently widen the filter
        setFilters((f) =>
          f.site && !data.sites.some((s) => s.site === f.site) ? { ...f, site: "" } : f,
        );
      })
      .catch((err) => live && report(err));
    return () => {
      live = false;
    };
  }, [token, from, to, api, report, nonce]);

  const loadGen = useRef(0);
  useEffect(() => {
    if (!token) return;
    const gen = ++loadGen.current;
    say(offset ? "Loading more…" : "Loading…");
    api("replays", {
      site: filters.site,
      from: String(from),
      to: String(to),
      q: filters.q,
      limit: String(PAGE),
      offset: String(offset),
      exclude: excluded,
    })
      .then((data: { visits: Visit[]; total: number; truncated: boolean }) => {
        // a slower earlier request must not overwrite a newer answer
        if (gen !== loadGen.current) return;
        setVisits((prev) => (offset ? prev.concat(data.visits) : data.visits));
        setTotal(data.total);
        setTruncated(data.truncated);
        say("");
      })
      .catch((err) => {
        if (gen === loadGen.current) report(err);
      });
  }, [token, filters, from, to, offset, excluded, api, report, say, nonce]);

  const update = (patch: Partial<Filters>) => {
    setOffset(0);
    setFilters((f) => ({ ...f, ...patch }));
  };

  const saveHidden = (next: Hidden[]) => {
    setHidden(next);
    setOffset(0);
    store.set(HIDDEN_KEY, JSON.stringify(next));
  };

  const mint = async (pv: string) => {
    const t = (await api("ticket", { pv }, "POST")) as { tk: string; site: string; path: string };
    return linkFor(t.site, t.path, t.tk);
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      say("Replay link copied — expires in 10 minutes");
    } catch {
      // no clipboard permission (or an insecure origin): show it rather than
      // swallow it, so the link is not lost
      say(`Copy this replay link (expires in 10 minutes): ${url}`);
    }
  };

  // The tab is opened on the click itself and navigated when the ticket comes
  // back: a window.open() after an await has lost its user gesture and dies in
  // a popup blocker. If it was blocked anyway, the link is still worth having.
  const replay = async (pv: string) => {
    const tab = window.open("", "_blank");
    if (tab) {
      try {
        tab.opener = null;
      } catch {
        /* nothing to do — the tab is still ours to navigate */
      }
    }
    say("Minting replay link…");
    try {
      const url = await mint(pv);
      // A site key is a hostname and carries no port, so a recording made on a
      // dev server can only ever produce http://localhost/… — not where it
      // happened. Hand the link over rather than open a tab that cannot work.
      if (LOCAL.test(new URL(url).hostname)) {
        tab?.close();
        await copy(url);
        return say(`Recorded on localhost, and a site key carries no port — open this on your dev server: ${url}`);
      }
      if (tab) {
        tab.location.replace(url);
        say("Replay opened in a new tab — it starts as soon as the page loads");
      } else {
        await copy(url);
      }
    } catch (err) {
      tab?.close();
      report(err);
    }
  };

  const header = (
    <header class="flex flex-wrap items-center gap-3 border-b border-line bg-panel px-5 py-3.5">
      <h1 class="text-[15px] font-semibold">heatmap-analytics</h1>
      <span class="text-[13px] text-dim">replays across every connected site</span>
      <span class="flex-1" />
      {token && (
        <>
          <button id="refresh" type="button" class="hma-btn" onClick={() => setNonce(nonce + 1)}>
            Refresh
          </button>
          <button
            id="signout"
            type="button"
            class="hma-btn"
            title="Forget the viewer token on this device"
            onClick={() => {
              store.set(TOKEN_KEY, "");
              setToken("");
              say("Signed out on this device");
            }}
          >
            Sign out
          </button>
        </>
      )}
    </header>
  );

  const statusLine = (
    <p
      id="status"
      class={`mt-2.5 min-h-5 px-5 ${status.error ? "text-warn" : "text-dim"}`}
      role="status"
    >
      {status.msg}
    </p>
  );

  if (!token) {
    return (
      <>
        {header}
        <Gate
          onToken={(t) => {
            store.set(TOKEN_KEY, t);
            say("");
            setToken(t);
          }}
        />
        {statusLine}
      </>
    );
  }

  return (
    <>
    {header}
    <main id="app" class="mx-auto max-w-7xl px-5 pt-4 pb-16">
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <select
          id="site"
          aria-label="Site"
          // a select is as wide as its widest option, and a hostname on
          // workers.dev is wide enough to push everything else off the row
          class="hma-field max-w-64"
          value={filters.site}
          onChange={(e) => update({ site: (e.target as HTMLSelectElement).value })}
        >
          <option value="">All sites ({sites.length})</option>
          {sites.map((s) => (
            <option key={s.site} value={s.site}>
              {s.site} — {s.pageviews} pageviews
            </option>
          ))}
        </select>

        <select
          id="range"
          aria-label="Date range"
          class="hma-field"
          value={filters.range}
          onChange={(e) => {
            const range = (e.target as HTMLSelectElement).value;
            update(
              range === "custom" && !filters.from
                ? { range, from: toDateInput(Date.now() - 7 * DAY), to: toDateInput(Date.now()) }
                : { range },
            );
          }}
        >
          <option value="today">Today</option>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="0">All time</option>
          <option value="custom">Custom…</option>
        </select>

        {filters.range === "custom" && (
          <span id="dates" class="flex items-center gap-1.5">
            <input
              id="from"
              type="date"
              aria-label="From date"
              class="hma-field"
              value={filters.from}
              onChange={(e) => update({ from: (e.target as HTMLInputElement).value })}
            />
            <input
              id="to"
              type="date"
              aria-label="To date"
              class="hma-field"
              value={filters.to}
              onChange={(e) => update({ to: (e.target as HTMLInputElement).value })}
            />
          </span>
        )}

        <input
          id="q"
          type="search"
          placeholder="path contains…"
          aria-label="Path contains"
          class="hma-field min-w-40 flex-1"
          value={search}
          onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
        />

        <button
          id="hidden-toggle"
          type="button"
          class="hma-btn"
          aria-expanded={showHidden}
          onClick={() => setShowHidden(!showHidden)}
        >
          Hidden visitors ({hidden.length})
        </button>
      </div>

      {showHidden && (
        <HiddenPanel
          hidden={hidden}
          onShow={(sid) => saveHidden(hidden.filter((h) => h.sid !== sid))}
          onAdd={(sid) =>
            hidden.some((h) => h.sid === sid) ||
            saveHidden([{ sid, label: "added by hand", at: Date.now() }, ...hidden])
          }
        />
      )}

      <Summary
        visits={visits}
        total={total}
        truncated={truncated}
        label={label}
        hiddenCount={hidden.length}
      />

      <div id="list" class="overflow-x-auto rounded-lg border border-line bg-panel">
        {visits.length === 0 && !status.msg ? (
          <p class="px-1 py-7 text-center text-dim">
            No visits recorded in this range — try a wider date range.
          </p>
        ) : (
          <table class="w-full min-w-3xl border-collapse text-left">
            <thead>
              <tr>
                {COLUMNS.map((col) => (
                  <th
                    key={col.label}
                    scope="col"
                    title={col.title}
                    class={`border-b border-line px-2 pt-3 pb-2 text-xs font-semibold tracking-wide
                      text-dim uppercase ${col.align === "right" ? "text-right" : "text-left"}
                      ${col.grow ? "w-full" : ""}`}
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            {visits.map((visit) => (
              <VisitRow
                key={visit.episode}
                visit={visit}
                repeat={repeats.get(visit.session_id) ?? 1}
                onReplay={(pv) => void replay(pv)}
                onCopy={(pv) => void mint(pv).then(copy).catch(report)}
                onHide={(v) =>
                  hidden.some((h) => h.sid === v.session_id) ||
                  saveHidden([
                    {
                      sid: v.session_id,
                      label: `${v.site} · ${shortId(v.episode)}`,
                      at: Date.now(),
                    },
                    ...hidden,
                  ])
                }
              />
            ))}
          </table>
        )}
      </div>

      {visits.length < total && (
        <button
          id="more"
          type="button"
          class="hma-btn mt-1 w-full"
          onClick={() => setOffset(visits.length)}
        >
          Load more
        </button>
      )}

      {statusLine}
    </main>
    </>
  );
}

render(<App />, document.getElementById("root") as HTMLElement);

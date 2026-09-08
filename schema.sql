CREATE TABLE IF NOT EXISTS pageviews (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,          -- anonymous id minted by the browser
  site        TEXT NOT NULL,
  path        TEXT NOT NULL,
  vw          INTEGER NOT NULL,
  vh          INTEGER NOT NULL,
  started_at  INTEGER NOT NULL,          -- epoch ms
  duration_ms INTEGER NOT NULL DEFAULT 0, -- wall clock to the last event; chains episodes
  -- Engaged time, measured in the browser. Nullable on purpose: NULL is "never
  -- measured" and the read API reconstructs it; 0 is "measured, nobody there".
  active_ms   INTEGER,
  max_scroll  INTEGER NOT NULL DEFAULT 0, -- percent 0..100
  -- ISO 3166-1 alpha-2 from the edge, NULL when no edge set it. The connecting
  -- IP is never read here. See country() in src/api.ts.
  country     TEXT
);

CREATE TABLE IF NOT EXISTS events (
  pv   TEXT NOT NULL,                    -- pageviews.id
  seq  INTEGER NOT NULL,                 -- client-side ordering across flushes
  k    TEXT NOT NULL,                    -- c=click m=move s=scroll r=rage-click
  sel  TEXT,                             -- element selector (c/m)
  rx   REAL,                             -- 0..1 position within element (c/m)
  ry   REAL,
  x    INTEGER,                          -- viewport px (c/m); NULL for s
  y    INTEGER,                          -- viewport px (c/m), scrollY px for s
  t    INTEGER NOT NULL                  -- ms since pageview start
);

-- unique so re-sent batches (fetch-keepalive fallback after a failed beacon)
-- can be INSERT OR IGNOREd instead of duplicating
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_pv_seq ON events (pv, seq);
CREATE INDEX IF NOT EXISTS idx_pageviews_site_path ON pageviews (site, path, started_at);
CREATE INDEX IF NOT EXISTS idx_pageviews_started ON pageviews (started_at);
-- journey/episode lookups. A session id never rotates, so these read a lot.
CREATE INDEX IF NOT EXISTS idx_pageviews_site_session
  ON pageviews (site, session_id, started_at);

-- Replay deep links land on the tracked site, not the owner's origin, so
-- whatever authorises one is readable by every script there. Never the
-- VIEWER_TOKEN: a random id, minutes long, one visitor on one site.
CREATE TABLE IF NOT EXISTS replay_tickets (
  id          TEXT PRIMARY KEY,
  site        TEXT NOT NULL,
  pv          TEXT NOT NULL,      -- the pageview the replay starts from
  session_id  TEXT NOT NULL,      -- everything the ticket may read is this visitor's
  expires_at  INTEGER NOT NULL    -- epoch ms; checked on use and swept nightly
);
-- No index on expires_at: every read is by primary key, and a minutes-long TTL
-- keeps this at tens of rows — an index would cost a write on every mint.

-- session_id was a salted hash of ip+user-agent rotated daily out of this
-- table; it is a browser-minted random id now. Hash-era rows keep theirs and
-- simply never chain.
DROP TABLE IF EXISTS salts;

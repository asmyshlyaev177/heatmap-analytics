CREATE TABLE IF NOT EXISTS pageviews (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,          -- anonymous id minted by the browser
  site        TEXT NOT NULL,
  path        TEXT NOT NULL,
  vw          INTEGER NOT NULL,
  vh          INTEGER NOT NULL,
  started_at  INTEGER NOT NULL,          -- epoch ms
  duration_ms INTEGER NOT NULL DEFAULT 0,
  max_scroll  INTEGER NOT NULL DEFAULT 0 -- percent 0..100
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
-- journey/episode lookups: every pageview of one session, in order. A session
-- id never rotates, so these read more rows than they used to.
CREATE INDEX IF NOT EXISTS idx_pageviews_site_session
  ON pageviews (site, session_id, started_at);

-- session_id used to be a server-side salted hash of ip+user-agent, rotated
-- daily out of this table. It is now a random id the browser mints once and
-- keeps in localStorage, so nothing here has to be derived or rotated. Rows
-- written under the old scheme keep their hash; they simply never chain to a
-- localStorage id.
DROP TABLE IF EXISTS salts;

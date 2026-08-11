-- 002: replay deep links.
--
-- The dashboard lists recordings from every connected site, and a replay runs
-- on the recorded page — which is not the owner's origin. Sending the
-- VIEWER_TOKEN there would hand a permanent, full-read credential to every
-- script on that site, and leave it in the address bar and history besides. A
-- ticket is the narrow alternative: random, minutes-long, and scoped to one
-- visitor's recordings on one site.
--
-- CREATE TABLE IF NOT EXISTS, so unlike 001 this one is safe to re-run — it is
-- the same statement schema.sql carries for a fresh database.
CREATE TABLE IF NOT EXISTS replay_tickets (
  id          TEXT PRIMARY KEY,
  site        TEXT NOT NULL,
  pv          TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);

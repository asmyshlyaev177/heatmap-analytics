-- 003: the visitor's country, as the edge resolved it.
--
-- Nullable and staying that way: NULL is "no geolocation header" — local dev,
-- the e2e endpoint, a host that does not geolocate. Written on insert only, so
-- a later flush cannot re-place a visit.
--
-- Re-running errors on the duplicate column, which means it already landed.
ALTER TABLE pageviews ADD COLUMN country TEXT;

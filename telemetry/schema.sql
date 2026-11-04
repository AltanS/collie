-- The install-count table (M86 spec 04). One row per install per UTC day.
-- No IP address, user agent or country column, on purpose.
CREATE TABLE IF NOT EXISTS pings (
  id      TEXT NOT NULL,
  day     TEXT NOT NULL,
  version TEXT NOT NULL,
  os      TEXT NOT NULL,
  arch    TEXT NOT NULL,
  install TEXT NOT NULL,
  line    TEXT NOT NULL,
  PRIMARY KEY (id, day)
);

-- The daily prune and every count below filter on day.
CREATE INDEX IF NOT EXISTS pings_day ON pings (day);

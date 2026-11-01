-- Password endpoint throttling. Login, admin login and registration each count
-- one attempt per client IP and per target email inside a short window.
-- The Worker degrades to "no throttle" when this table is missing, so applying
-- the migration is recommended but never required to keep signing in.
CREATE TABLE IF NOT EXISTS auth_limits (
  scope TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_limits_window_idx ON auth_limits(window_start);

-- Resumable public-share directory scans for the admin catalog preview.
-- A scan is read in small batches so one Worker request never has to walk a
-- whole large share; finished or stale rows are deleted by the API.
CREATE TABLE IF NOT EXISTS netdisk_scans (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_netdisk_scans_updated_at ON netdisk_scans(updated_at);

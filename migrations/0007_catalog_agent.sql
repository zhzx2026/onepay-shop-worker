-- Public, explicitly reviewed catalog snapshots. Delivery links and extraction
-- codes remain private in the existing delivery_url column.
ALTER TABLE products ADD COLUMN preview_files TEXT NOT NULL DEFAULT '[]';
ALTER TABLE products ADD COLUMN preview_source TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN preview_updated_at TEXT;
ALTER TABLE products ADD COLUMN preview_truncated INTEGER NOT NULL DEFAULT 0;

-- One idempotency key creates at most one hidden product draft, even on retry.
CREATE TABLE IF NOT EXISTS agent_product_jobs (
  idempotency_key TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  product_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Login throttling: one row per identity window, purged by the API.
-- Recording failures instead of sessions keeps this table tiny and lets the
-- Worker answer 429 before doing any expensive PBKDF2 work.
CREATE TABLE IF NOT EXISTS auth_attempts (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_attempts_window_idx ON auth_attempts(window_start);

-- Reusing a purchase entry within a short window looks up the latest intent.
CREATE INDEX IF NOT EXISTS purchase_intents_user_sku_idx
  ON purchase_intents(user_id, sku_id, created_at DESC);

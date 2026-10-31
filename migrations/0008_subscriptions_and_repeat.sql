-- Existing and new ordinary goods default to one completed purchase per user.
-- Timed subscriptions are renewed manually and have their own entitlement rules.
ALTER TABLE products ADD COLUMN allow_repeat INTEGER NOT NULL DEFAULT 0 CHECK(allow_repeat IN (0,1));
ALTER TABLE products ADD COLUMN product_kind TEXT NOT NULL DEFAULT 'SINGLE' CHECK(product_kind IN ('SINGLE','SUBSCRIPTION'));
ALTER TABLE products ADD COLUMN subscription_days INTEGER NOT NULL DEFAULT 0 CHECK(subscription_days BETWEEN 0 AND 3650);
ALTER TABLE products ADD COLUMN update_frequency TEXT NOT NULL DEFAULT 'IRREGULAR' CHECK(update_frequency IN ('IRREGULAR','DAILY','WEEKLY'));

-- Snapshot the purchased terms so later edits cannot change an existing order.
ALTER TABLE orders ADD COLUMN product_kind TEXT NOT NULL DEFAULT 'SINGLE' CHECK(product_kind IN ('SINGLE','SUBSCRIPTION'));
ALTER TABLE orders ADD COLUMN subscription_days INTEGER NOT NULL DEFAULT 0 CHECK(subscription_days BETWEEN 0 AND 3650);
CREATE INDEX IF NOT EXISTS orders_owner_product_status_idx ON orders(user_id,product_id,status);

CREATE TABLE IF NOT EXISTS subscriptions (
  user_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  permanent INTEGER NOT NULL DEFAULT 0 CHECK(permanent IN (0,1)),
  expires_at INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id,product_id),
  CHECK((permanent=1 AND expires_at IS NULL) OR (permanent=0 AND expires_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS subscription_updates (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  delivery_type TEXT NOT NULL CHECK(delivery_type IN ('TEXT','LINK','FILE')),
  delivery_text TEXT NOT NULL DEFAULT '',
  delivery_url TEXT NOT NULL DEFAULT '',
  file_key TEXT NOT NULL DEFAULT '',
  file_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PUBLISHED' CHECK(status IN ('PUBLISHED','HIDDEN')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS subscription_updates_product_idx ON subscription_updates(product_id,status,created_at DESC);

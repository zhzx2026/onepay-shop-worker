-- 积分制商品与订单：后台自助上架商品，用户用积分兑换，交付内容为文本 / 链接 / 文件
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  price_points INTEGER NOT NULL,
  cover_url TEXT NOT NULL DEFAULT '',
  delivery_type TEXT NOT NULL CHECK(delivery_type IN ('TEXT','LINK','FILE')),
  delivery_text TEXT NOT NULL DEFAULT '',
  delivery_url TEXT NOT NULL DEFAULT '',
  file_key TEXT NOT NULL DEFAULT '',
  file_name TEXT NOT NULL DEFAULT '',
  stock INTEGER,
  sold_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','HIDDEN')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS products_status_idx ON products(status, sort_order DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS orders (
  idempotency_key TEXT PRIMARY KEY,
  order_no TEXT NOT NULL,
  user_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  title TEXT NOT NULL,
  price_points INTEGER NOT NULL,
  delivery_type TEXT NOT NULL,
  delivery_text TEXT NOT NULL DEFAULT '',
  delivery_url TEXT NOT NULL DEFAULT '',
  file_key TEXT NOT NULL DEFAULT '',
  file_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','DELIVERED','FAILED')),
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS orders_user_idx ON orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_product_idx ON orders(product_id, created_at DESC);

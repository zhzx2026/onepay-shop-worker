-- 商品分类（支持一级分类与二级子分类）及商品标签
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','HIDDEN')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS categories_parent_idx ON categories(parent_id, sort_order DESC);
CREATE INDEX IF NOT EXISTS categories_status_idx ON categories(status, sort_order DESC);

ALTER TABLE products ADD COLUMN category_id TEXT;
ALTER TABLE products ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
CREATE INDEX IF NOT EXISTS products_category_idx ON products(category_id, status, sort_order DESC);

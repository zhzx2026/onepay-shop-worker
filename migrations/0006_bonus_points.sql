-- 店铺赠送积分与一人付权益分开记账；余额变更和订单预留均在 D1 事务中完成。
CREATE TABLE IF NOT EXISTS bonus_wallets (
  user_id TEXT PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bonus_ledger (
  operation_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  kind TEXT NOT NULL,
  actor_id TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  order_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bonus_ledger_user_idx ON bonus_ledger(user_id, created_at DESC);

-- 旧订单均已按原价核销，默认赠送积分为 0，不改变既有订单的扣费方式。
ALTER TABLE orders ADD COLUMN bonus_points_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN processing_token TEXT;
ALTER TABLE orders ADD COLUMN processing_until INTEGER NOT NULL DEFAULT 0;

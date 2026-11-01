-- 1) webhook_events 原本只入库、无人消费（/api/webhook 仅 INSERT OR IGNORE）。
--    增加消费标记，让 cron 能「处理一次就不重复扫」，同时保留原始 payload 作为对账凭据。
ALTER TABLE webhook_events ADD COLUMN consumed_at TEXT;
CREATE INDEX IF NOT EXISTS idx_webhook_events_consumed ON webhook_events(consumed_at, received_at);

-- 2) 订单收敛尝试计数：达到阈值仍无上游确定结论时，reaper 会写一条审计
--    （orders.reconcile_stalled）提示人工核对账单，避免订单无声冻结。
ALTER TABLE orders ADD COLUMN reconcile_attempts INTEGER NOT NULL DEFAULT 0;

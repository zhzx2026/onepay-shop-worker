// Local promotional credits are separate from the provider's balance.
// D1 batch() is transactional: stock, orders, wallet and ledger commit together.
const MAX_BALANCE = 1_000_000_000;
const timestamp = () => new Date().toISOString();

export async function bonusBalance(env, userId) {
  const row = await env.DB.prepare('SELECT balance FROM bonus_wallets WHERE user_id=?').bind(userId).first();
  return Number(row?.balance || 0);
}

export async function bonusHistory(env, userId) {
  const rows = await env.DB.prepare('SELECT operation_key,delta,balance_after,kind,actor_id,reason,order_key,created_at FROM bonus_ledger WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20').bind(userId).all();
  return rows.results || [];
}

export async function adjustBonus(env, { userId, actorId, delta, reason, key }) {
  const op = `admin:${key}`;
  const at = timestamp();
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO bonus_wallets(user_id,balance,updated_at) SELECT id,0,? FROM users WHERE id=?').bind(at, userId),
    env.DB.prepare(`UPDATE bonus_wallets SET balance=balance+?,updated_at=?
      WHERE user_id=? AND balance+? >= 0
      AND balance+? + COALESCE((SELECT SUM(bonus_points_used) FROM orders WHERE user_id=? AND status='PENDING'),0) <= ?
      AND NOT EXISTS (SELECT 1 FROM bonus_ledger WHERE operation_key=?)`).bind(delta, at, userId, delta, delta, userId, MAX_BALANCE, op),
    env.DB.prepare(`INSERT INTO bonus_ledger(operation_key,user_id,delta,balance_after,kind,actor_id,reason,created_at)
      SELECT ?,user_id,?,balance,'admin',?,?,? FROM bonus_wallets WHERE user_id=? AND changes()=1`).bind(op, delta, actorId, reason, at, userId),
    env.DB.prepare(`INSERT INTO admin_audit(id,action,target,detail,created_at)
      SELECT ?,'user.bonus_adjusted',user_id,?,? FROM bonus_ledger WHERE operation_key=? AND changes()=1`)
      .bind('aud_' + crypto.randomUUID(), `管理员 ${actorId}；变动 ${delta}；原因：${reason}`, at, op),
  ]);
  const entry = await env.DB.prepare('SELECT * FROM bonus_ledger WHERE operation_key=?').bind(op).first();
  if (!entry) return { ok: false, code: 'BALANCE_LIMIT' };
  if (entry.user_id !== userId || entry.actor_id !== actorId || Number(entry.delta) !== delta || entry.reason !== reason) {
    return { ok: false, code: 'IDEMPOTENCY_CONFLICT' };
  }
  return { ok: true, balance: Number(entry.balance_after), delta: Number(entry.delta) };
}

export async function reserveOrder(env, { productId, userId, key, orderNo }) {
  const at = timestamp();
  const result = await env.DB.batch([
    env.DB.prepare("UPDATE products SET stock=stock-1,sold_count=sold_count+1,updated_at=? WHERE id=? AND status='ACTIVE' AND (stock IS NULL OR stock>0) AND EXISTS (SELECT 1 FROM users WHERE id=? AND COALESCE(disabled,0)=0) AND NOT EXISTS (SELECT 1 FROM orders WHERE user_id=? AND product_id=? AND status='PENDING')").bind(at, productId, userId, userId, productId),
    env.DB.prepare(`INSERT INTO orders(idempotency_key,order_no,user_id,product_id,title,price_points,delivery_type,delivery_text,delivery_url,file_key,file_name,status,created_at,bonus_points_used)
      SELECT ?,?,?,p.id,p.title,p.price_points,p.delivery_type,p.delivery_text,p.delivery_url,p.file_key,p.file_name,'PENDING',?,
        MIN(p.price_points,COALESCE((SELECT balance FROM bonus_wallets WHERE user_id=?),0))
      FROM products p WHERE p.id=? AND changes()=1`).bind(key, orderNo, userId, at, userId, productId),
    env.DB.prepare(`UPDATE bonus_wallets SET balance=balance-(SELECT bonus_points_used FROM orders WHERE idempotency_key=?),updated_at=?
      WHERE user_id=? AND changes()=1 AND (SELECT bonus_points_used FROM orders WHERE idempotency_key=?)>0`).bind(key, at, userId, key),
    env.DB.prepare(`INSERT INTO bonus_ledger(operation_key,user_id,delta,balance_after,kind,reason,order_key,created_at)
      SELECT 'reserve:'||o.idempotency_key,o.user_id,-o.bonus_points_used,w.balance,'reserve','兑换预留',o.idempotency_key,?
      FROM orders o JOIN bonus_wallets w ON w.user_id=o.user_id WHERE o.idempotency_key=? AND changes()=1`).bind(at, key),
  ]);
  return Number(result[1]?.meta?.changes || 0) === 1;
}

export async function refundOrder(env, key, token) {
  const at = timestamp();
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE bonus_wallets SET balance=balance+(SELECT bonus_points_used FROM orders WHERE idempotency_key=?),updated_at=?
      WHERE user_id=(SELECT user_id FROM orders WHERE idempotency_key=? AND status='PENDING' AND processing_token=? AND bonus_points_used>0)`).bind(key, at, key, token),
    env.DB.prepare(`INSERT INTO bonus_ledger(operation_key,user_id,delta,balance_after,kind,reason,order_key,created_at)
      SELECT 'release:'||o.idempotency_key,o.user_id,o.bonus_points_used,w.balance,'release','兑换失败返还',o.idempotency_key,?
      FROM orders o JOIN bonus_wallets w ON w.user_id=o.user_id WHERE o.idempotency_key=? AND o.status='PENDING' AND o.processing_token=? AND changes()=1`).bind(at, key, token),
    env.DB.prepare(`UPDATE products SET stock=CASE WHEN stock IS NULL THEN NULL ELSE stock+1 END,
      sold_count=CASE WHEN sold_count>0 THEN sold_count-1 ELSE 0 END,updated_at=?
      WHERE id=(SELECT product_id FROM orders WHERE idempotency_key=? AND status='PENDING' AND processing_token=?)`).bind(at, key, token),
    env.DB.prepare("UPDATE orders SET status='FAILED' WHERE idempotency_key=? AND status='PENDING' AND processing_token=?").bind(key, token),
  ]);
  return Number(result[3]?.meta?.changes || 0) === 1;
}

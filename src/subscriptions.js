// Subscription entitlements are local to the shop; no automatic billing occurs.
const MAX_DAYS = 3650;
export const SUBSCRIPTION_FREQUENCIES = new Set(['IRREGULAR', 'DAILY', 'WEEKLY']);
export const validSubscriptionDays = value => Number.isInteger(value) && value >= 0 && value <= MAX_DAYS;

export function isSubscriptionActive(row, nowSeconds = Math.floor(Date.now() / 1000)) {
  return Boolean(row && (Number(row.permanent) === 1 || Number(row.expires_at) > nowSeconds));
}

// A successful transition and its entitlement grant are a single D1 batch.
// Retrying the same order cannot extend an entitlement a second time.
export async function finalizeSubscriptionOrder(env, key, token, at = new Date()) {
  const iso = at.toISOString(), seconds = Math.floor(at.getTime() / 1000);
  await env.DB.batch([
    env.DB.prepare("UPDATE orders SET status='DELIVERED',delivered_at=? WHERE idempotency_key=? AND status='PENDING' AND processing_token=?")
      .bind(iso, key, token),
    env.DB.prepare(`INSERT INTO subscriptions(user_id,product_id,permanent,expires_at,updated_at)
      SELECT user_id,product_id,CASE WHEN subscription_days=0 THEN 1 ELSE 0 END,
        CASE WHEN subscription_days=0 THEN NULL ELSE ?+subscription_days*86400 END,?
      FROM orders WHERE idempotency_key=? AND product_kind='SUBSCRIPTION' AND changes()=1
      ON CONFLICT(user_id,product_id) DO UPDATE SET
        permanent=CASE WHEN subscriptions.permanent=1 OR excluded.permanent=1 THEN 1 ELSE 0 END,
        expires_at=CASE WHEN subscriptions.permanent=1 OR excluded.permanent=1 THEN NULL
          ELSE MAX(COALESCE(subscriptions.expires_at,0),?)+(excluded.expires_at-?) END,
        updated_at=excluded.updated_at`)
      .bind(seconds, iso, key, seconds, seconds),
  ]);
  return env.DB.prepare('SELECT * FROM orders WHERE idempotency_key=?').bind(key).first();
}

export async function subscriptionFor(env, userId, productId) {
  return env.DB.prepare('SELECT * FROM subscriptions WHERE user_id=? AND product_id=?').bind(userId, productId).first();
}

export function subscriptionView(row) {
  return {
    product_id: row.product_id,
    title: row.title || '订阅系列',
    cover_url: row.cover_url || '',
    permanent: Number(row.permanent) === 1,
    revision: Number(row.permanent) === 1 ? 'permanent' : `until:${Number(row.expires_at)}`,
    expires_at: row.expires_at == null ? null : new Date(Number(row.expires_at) * 1000).toISOString(),
    active: isSubscriptionActive(row),
    status: row.status || 'HIDDEN',
    updated_at: row.updated_at,
  };
}

export function parseSubscriptionUpdate(body) {
  const title = String(body.title ?? '').trim();
  const summary = String(body.summary ?? '').trim();
  const type = String(body.delivery_type ?? '').toUpperCase();
  const text = String(body.delivery_text ?? '');
  const url = String(body.delivery_url ?? '').trim();
  const fileKey = String(body.file_key ?? '').trim();
  const fileName = String(body.file_name ?? '').trim();
  const status = String(body.status ?? 'PUBLISHED').toUpperCase();
  if (!title || title.length > 120 || summary.length > 500) return { ok: false, error: '更新标题需为 1–120 字，简介最多 500 字' };
  if (!['TEXT', 'LINK', 'FILE'].includes(type) || !['PUBLISHED', 'HIDDEN'].includes(status)) return { ok: false, error: '更新内容类型或状态无效' };
  if (type === 'TEXT' && (!text.trim() || text.length > 20000)) return { ok: false, error: '更新文本需为 1–20000 字' };
  if (type === 'LINK') {
    try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || url.length > 2000) throw new Error(); }
    catch { return { ok: false, error: '更新链接需为有效的 http(s) 地址' }; }
  }
  if (type === 'FILE' && (!fileKey || fileKey.length > 512 || fileName.length > 120)) return { ok: false, error: '请先上传更新文件，文件名最多 120 字' };
  return {
    ok: true,
    value: { title, summary, delivery_type: type, delivery_text: type === 'TEXT' ? text : '',
      delivery_url: type === 'LINK' ? url : '', file_key: type === 'FILE' ? fileKey : '',
      file_name: type === 'FILE' ? (fileName || fileKey.split('/').pop() || '下载文件').slice(0, 120) : '', status },
  };
}

export function subscriberUpdateView(row) {
  const delivery = row.delivery_type === 'TEXT' ? { type: 'TEXT', text: row.delivery_text }
    : row.delivery_type === 'LINK' ? { type: 'LINK', url: row.delivery_url }
      : { type: 'FILE', file: { name: row.file_name || '下载文件', download_path: `/api/subscriptions/${encodeURIComponent(row.product_id)}/updates/${encodeURIComponent(row.id)}/file` } };
  return { id: row.id, title: row.title, summary: row.summary, created_at: row.created_at, updated_at: row.updated_at, delivery };
}

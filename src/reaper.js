// PENDING 订单自愈 + Webhook 事件驱动收敛。
//
// 背景：purchaseProduct → processOrder 会先在 D1 里占住库存与赠送积分，再调用
// 一人付 /consume。一旦上游超时、Worker 中途被杀或客户端断开，订单一律停在
// PENDING，库存与赠送积分被永久占用，用户还会撞上 ORDER_ALREADY_PENDING。
// 仓库原本没有任何回收机制（无 [triggers]，/api/webhook 只入库不消费）。
//
// 安全边界（任何情况都不允许「上游扣了分、本地却退了库存」）：
//   1. 只有拿到订单租约（processing_token + processing_until，与 processOrder
//      完全相同的抢锁语句）才处理，绝不与请求线程抢同一单；
//   2. 从未向一人付发起过扣款的订单才允许直接退款——判据是本地台账
//      `consumption_jobs` 不存在或仍为 PREPARING（index.js 在真正 fetch 之前
//      才把状态改成 SUBMITTED），这类订单 /consumption 查询必然是 404；
//   3. 已进入 SUBMITTED 的订单只用**原 idempotency_key** 反查上游，
//      明确 SUCCEEDED && confirmed === true 才交付，明确终态失败才退款；
//      404 / 5xx / 超时 / PROCESSING 一律保持 PENDING，等下一轮或人工核查；
//   4. 纯赠送积分订单（external <= 0）没有上游扣分，卡住即「欠交付」，补交付。

import { refundOrder } from './bonus.js';
import { finalizeSubscriptionOrder } from './subscriptions.js';
import { invalidatePublicCache } from './cache.js';

const DEFAULT_API = 'https://ai6666.com/opcpay/api/pay/v1';
const STALE_SECONDS = 600;      // 10 分钟未收敛视为卡单
const LOCK_SECONDS = 300;       // 与 processOrder 的抢锁窗口一致
const FAILED_STATUSES = new Set(['FAILED', 'CANCELED', 'CANCELLED', 'REJECTED', 'EXPIRED']);
const MAX_PER_RUN = 10;         // 单次 cron 最多处理 10 单，避免超时
const MAX_EVENTS = 20;          // 单次 cron 最多消费 20 条 webhook 事件
const STALLED_ATTEMPTS = 12;    // 12 轮 × 5 分钟 ≈ 1 小时仍无结论 → 写审计交人工

const seconds = () => Math.floor(Date.now() / 1000);
const isoSeconds = value => new Date(value * 1000).toISOString();

async function apiKeyValue(env) {
  try {
    const row = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind('yirenfu_api_key').first();
    if (row?.value) return row.value;
  } catch { /* settings 表缺失时退回环境变量 */ }
  return env.YIRENFU_API_KEY || '';
}

// 只查询，不提交：同一 idempotency_key 的重复查询不会产生第二次扣款。
async function queryConsumption(env, userId, key) {
  const apiKey = await apiKeyValue(env);
  if (!apiKey) return { ok: false, reason: 'API_KEY_MISSING' };
  try {
    const response = await fetch(`${env.YIRENFU_API_BASE || DEFAULT_API}/consumption`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ user_id: userId, idempotency_key: key }),
      signal: AbortSignal.timeout(15000),
    });
    // 404 表示上游从未收到这笔扣款（见文件头第 2 条），与 5xx 区别对待。
    if (response.status === 404) return { ok: false, reason: 'NOT_SUBMITTED' };
    if (!response.ok) return { ok: false, reason: `HTTP_${response.status}` };
    const data = await response.json().catch(() => null);
    if (!data || typeof data !== 'object') return { ok: false, reason: 'BAD_JSON' };
    return { ok: true, data };
  } catch (error) {
    return { ok: false, reason: `NETWORK_${String(error?.name || 'ERROR')}` };
  }
}

async function flagStalled(env, order, attempts) {
  try {
    await env.DB.prepare('INSERT INTO admin_audit(id,action,target,detail,created_at) VALUES(?,?,?,?,?)')
      .bind('aud_' + crypto.randomUUID(), 'orders.reconcile_stalled', order.idempotency_key,
        `连续 ${attempts} 轮无法确认上游扣分结果，请人工核对一人付账单（金额 ${Number(order.price_points)}，用户 ${order.user_id}）`,
        new Date().toISOString()).run();
  } catch { /* 审计写失败不影响订单保持 PENDING */ }
}

function classify(data) {
  const status = String(data?.status || '').toUpperCase();
  if (status === 'SUCCEEDED' && data?.confirmed === true) return 'DELIVERED';
  if (FAILED_STATUSES.has(status)) return 'FAILED';
  return 'PENDING';
}

async function markDelivered(env, order, token) {
  if (order.product_kind === 'SUBSCRIPTION') {
    const row = await finalizeSubscriptionOrder(env, order.idempotency_key, token);
    return row?.status === 'DELIVERED';
  }
  const result = await env.DB.prepare(
    "UPDATE orders SET status='DELIVERED', delivered_at=? WHERE idempotency_key=? AND status='PENDING' AND processing_token=?"
  ).bind(new Date().toISOString(), order.idempotency_key, token).run();
  return Number(result.meta?.changes || 0) === 1;
}

// 与 index.js 的 saveLedger 等价，并补上租约守卫：订单处理权已易主时绝不覆盖台账。
async function saveLedger(env, order, data, token) {
  try {
    await env.DB.prepare(
      `UPDATE consumption_jobs SET status=?, response_json=?, updated_at=?
       WHERE idempotency_key=?
         AND EXISTS (SELECT 1 FROM orders WHERE idempotency_key=? AND processing_token=?)`
    ).bind(String(data?.status || 'UNKNOWN'), JSON.stringify(data || {}), new Date().toISOString(),
      order.idempotency_key, order.idempotency_key, token).run();
  } catch { /* 台账写失败不影响订单收敛结果 */ }
}

async function acquire(env, key, token, at) {
  const lock = await env.DB.prepare(
    "UPDATE orders SET processing_token=?, processing_until=? WHERE idempotency_key=? AND status='PENDING' AND (processing_token IS NULL OR processing_until<?)"
  ).bind(token, at + LOCK_SECONDS, key, at).run();
  return Number(lock.meta?.changes || 0) === 1;
}

async function release(env, key, token) {
  await env.DB.prepare('UPDATE orders SET processing_token=NULL,processing_until=0 WHERE idempotency_key=? AND processing_token=?')
    .bind(key, token).run().catch(() => {});
}

// 收敛单张订单。返回 'DELIVERED' | 'RELEASED' | 'PENDING' | 'SKIPPED'
async function reconcileOrder(env, order, report) {
  const key = order.idempotency_key;
  const token = crypto.randomUUID();
  const at = seconds();
  if (!await acquire(env, key, token, at)) return 'SKIPPED';
  try {
    const external = Number(order.price_points) - Number(order.bonus_points_used || 0);

    // 每轮收敛尝试都 +1：达到阈值仍无确定结论时落一条审计，后台「安全设置/审计」里能直接看到，
    // 避免「SUCCEEDED 但不带 confirmed 字段」这类上游差异导致订单无声冻结。
    let attempts = 0;
    try {
      const bumped = await env.DB.prepare('UPDATE orders SET reconcile_attempts=COALESCE(reconcile_attempts,0)+1 WHERE idempotency_key=? RETURNING reconcile_attempts AS n').bind(key).first();
      attempts = Number(bumped?.n || 0);
    } catch { attempts = 0; } // 未应用 0010 迁移时跳过

    // 纯赠送积分：从未调用一人付，卡住就是「欠交付」，补交付而不是退款。
    if (!(external > 0)) return (await markDelivered(env, order, token)) ? 'DELIVERED' : 'PENDING';

    const ledger = await env.DB.prepare('SELECT status,response_json FROM consumption_jobs WHERE idempotency_key=?').bind(key).first();
    const ledgerStatus = String(ledger?.status || '').toUpperCase();

    // 台账不存在或仍是 PREPARING ⇒ index.js 从未把状态推到 SUBMITTED，
    // 也就从未发出 /consume，此时退款 100% 安全（不退款则会永久卡死）。
    if (!ledger || ledgerStatus === 'PREPARING') {
      return (await refundOrder(env, key, token)) ? 'RELEASED' : 'PENDING';
    }

    let decision = 'PENDING', data = null;
    if (ledger.response_json) {
      try { data = JSON.parse(ledger.response_json); } catch { data = null; }
      if (data) decision = classify(data);
    }
    if (decision === 'PENDING') {
      const upstream = await queryConsumption(env, order.user_id, key);
      if (upstream.ok) { data = upstream.data; decision = classify(data); await saveLedger(env, order, data, token); }
      // 上游 404 / 5xx / 超时一律视为「不确定」：与 index.js:242-247 的既有语义保持一致。
      // 即便台账已是 SUBMITTED 也绝不自动退款——只在达到阈值后落一条审计，交人工核查。
    }
    if (decision === 'DELIVERED') return (await markDelivered(env, order, token)) ? 'DELIVERED' : 'PENDING';
    if (decision === 'FAILED') return (await refundOrder(env, key, token)) ? 'RELEASED' : 'PENDING';
    if (attempts === STALLED_ATTEMPTS) await flagStalled(env, order, attempts);
    return 'PENDING'; // 上游仍无确定结论：保持原样，下一轮再来，绝不自动退款
  } catch {
    report.errors++;
    return 'PENDING';
  } finally {
    await release(env, key, token);
  }
}

function eventOrderKey(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const candidates = [
    payload.idempotency_key, payload.business_id,
    payload.data?.idempotency_key, payload.data?.business_id,
    payload.consumption?.idempotency_key, payload.consumption?.business_id,
    payload.object?.idempotency_key,
  ];
  for (const value of candidates) {
    const key = String(value ?? '').trim();
    if (key) return key.slice(0, 128);
  }
  return '';
}

// 消费 webhook_events：只有事件里带得出订单幂等键时才精确触发对应订单，
// 否则仅标记录入时间，绝不靠 user_id + 金额去猜（同用户并发多单会错配交付）。
async function consumeWebhookEvents(env, report, origin, limit = MAX_EVENTS) {
  let rows;
  try {
    rows = await env.DB.prepare(
      'SELECT event_id, payload_json FROM webhook_events WHERE consumed_at IS NULL ORDER BY received_at ASC LIMIT ?'
    ).bind(limit).all();
  } catch { return 0; } // 未应用 0010 迁移时静默跳过
  let handled = 0;
  for (const row of rows.results || []) {
    let key = '';
    try { key = eventOrderKey(JSON.parse(row.payload_json || '{}')); } catch { key = ''; }
    let shouldRetry = false;
    if (key) {
      const order = await env.DB.prepare("SELECT * FROM orders WHERE idempotency_key=? AND status='PENDING'").bind(key).first();
      if (order) {
        const outcome = await reconcileOrder(env, order, report);
        if (outcome === 'DELIVERED') report.delivered++;
        else if (outcome === 'RELEASED') report.released++;
        else if (outcome === 'PENDING') { report.pending++; shouldRetry = true; }
        else { report.skipped++; shouldRetry = true; }
        if (outcome !== 'PENDING' && outcome !== 'SKIPPED') handled++;
      }
    }
    if (!shouldRetry) {
      await env.DB.prepare('UPDATE webhook_events SET consumed_at=? WHERE event_id=?')
        .bind(new Date().toISOString(), row.event_id).run().catch(() => {});
    }
  }
  if (handled && origin) {
    try { await invalidatePublicCache({ url: origin }, ['catalog']); } catch { /* 忽略 */ }
  }
  return handled;
}

/**
 * @returns {{scanned:number, delivered:number, released:number, pending:number, skipped:number, errors:number, webhook_handled:number}}
 */
export async function reapPendingOrders(env, { origin = '', staleSeconds = STALE_SECONDS, limit = MAX_PER_RUN } = {}) {
  const report = { scanned: 0, delivered: 0, released: 0, pending: 0, skipped: 0, errors: 0, webhook_handled: 0 };
  if (!env?.DB) return report;

  let rows;
  try {
    rows = await env.DB.prepare(
      "SELECT * FROM orders WHERE status='PENDING' AND created_at < ? ORDER BY created_at ASC LIMIT ?"
    ).bind(isoSeconds(seconds() - staleSeconds), Math.max(1, Math.min(50, limit))).all();
  } catch { return report; }

  for (const order of rows.results || []) {
    report.scanned++;
    const outcome = await reconcileOrder(env, order, report);
    if (outcome === 'DELIVERED') report.delivered++;
    else if (outcome === 'RELEASED') report.released++;
    else if (outcome === 'PENDING') report.pending++;
    else report.skipped++;
  }

  report.webhook_handled = await consumeWebhookEvents(env, report, origin);

  if ((report.delivered || report.released) && origin) {
    // 库存/在售数量变化，公开货架缓存需要失效；scheduled 里没有 request，用 origin 造一个。
    try { await invalidatePublicCache({ url: origin }, ['catalog']); } catch { /* 缓存失效失败不影响结果 */ }
  }
  return report;
}

// cron 入口：回收卡单 + 消费 webhook 事件。
export async function runMaintenance(env, ctx, origin = '') {
  return reapPendingOrders(env, { origin: origin || env.SITE_ORIGIN || '' });
}

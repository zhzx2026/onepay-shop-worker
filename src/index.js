import { cachedPublicJson, invalidatePublicCache, withStaticCache, productTagFilters } from './cache.js';
import { detectNetdisk, providerTags, normalizePreview, readShareDirectory } from './netdisk.js';
import { bonusBalance, bonusHistory, adjustBonus, reserveOrder, refundOrder } from './bonus.js';

const API = 'https://ai6666.com/opcpay/api/pay/v1';
const encoder = new TextEncoder();
// Cloudflare Workers 的 WebCrypto 对 PBKDF2 迭代次数上限为 100000，超过会直接抛错。
const PBKDF2_ITERATIONS = 100000;
const DELIVERY_TYPES = new Set(['TEXT', 'LINK', 'FILE']);
const PRODUCT_STATUS = new Set(['ACTIVE', 'HIDDEN']);
const CATEGORY_STATUS = new Set(['ACTIVE', 'HIDDEN']);
const MAX_PRODUCT_TAGS = 8;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', ...headers } });
}
function fail(status, error, code = 'REQUEST_FAILED') { return json({ error, error_code: code }, status); }
function now() { return new Date().toISOString(); }
function id(prefix = '') { return prefix + crypto.randomUUID(); }
function b64(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function sha256(value) { return b64(await crypto.subtle.digest('SHA-256', encoder.encode(value))); }
function constantEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0;
}
async function passwordHash(password, salt = b64(crypto.getRandomValues(new Uint8Array(16))), iterations = PBKDF2_ITERATIONS) {
  const rounds = Math.max(1, Math.min(PBKDF2_ITERATIONS, Number(iterations) || PBKDF2_ITERATIONS));
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations: rounds, hash: 'SHA-256' }, key, 256);
  return `${rounds}.${salt}.${b64(bits)}`;
}
async function passwordMatches(password, saved) {
  try {
    const parts = String(saved || '').split('.');
    const [rounds, salt, expected] = parts.length >= 3 ? [parts[0], parts[1], parts[2]] : [PBKDF2_ITERATIONS, parts[0], parts[1]];
    if (!salt || !expected || !Number.isFinite(Number(rounds))) return false;
    const candidate = await passwordHash(password, salt, Number(rounds));
    return constantEq(candidate.split('.')[2] || '', expected);
  } catch { return false; }
}
function cookie(name, value, maxAge) { return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`; }
function getCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) { const [k, ...v] = part.trim().split('='); if (k === name) return v.join('='); }
  return '';
}
async function bodyJson(request, max = 65536) {
  const text = await request.text();
  if (text.length > max) throw new Error('BODY_TOO_LARGE');
  const data = JSON.parse(text || '{}');
  if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('INVALID_JSON');
  return data;
}
function validText(v, min, max) { return typeof v === 'string' && v.trim() === v && v.length >= min && v.length <= max; }
function httpUrl(v) { try { const u = new URL(v); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; } }
function originOk(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  try { return new URL(origin).host === new URL(request.url).host; } catch { return false; }
}
function sessionCookieName(env, scope = 'user') {
  return scope === 'admin' ? (env.ADMIN_COOKIE_NAME || 'onepay_admin_session') : (env.COOKIE_NAME || 'onepay_session');
}
async function currentSession(request, env, scope = 'user') {
  const raw = getCookie(request, sessionCookieName(env, scope));
  if (!raw) return null;
  const row = await env.DB.prepare(
    `SELECT s.user_id, s.expires_at, u.email, u.role, COALESCE(u.disabled,0) AS disabled
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`
  ).bind(await sha256(raw)).first();
  if (!row || row.disabled || row.expires_at < Math.floor(Date.now() / 1000)) return null;
  return { id: row.user_id, email: row.email, role: row.role };
}
async function requireUser(request, env) {
  const user = await currentSession(request, env, 'user');
  if (!user) throw Object.assign(new Error('请先登录'), { status: 401, code: 'AUTH_REQUIRED' });
  return user;
}
async function requireAdmin(request, env) {
  const user = await currentSession(request, env, 'admin');
  if (!user || user.role !== 'admin') throw Object.assign(new Error('需要管理员账号登录'), { status: 401, code: 'AUTH_REQUIRED' });
  return user;
}
async function createSession(env, userId, role) {
  const token = b64(crypto.getRandomValues(new Uint8Array(32)));
  const days = Math.max(1, Math.min(30, Number(env.SESSION_DAYS || 14)));
  const expires = Math.floor(Date.now() / 1000) + days * 86400;
  await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,role,expires_at,created_at) VALUES(?,?,?,?,?)')
    .bind(await sha256(token), userId, role, expires, now()).run();
  return { token, maxAge: days * 86400 };
}
async function getSetting(env, key) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first();
  return row ? row.value : null;
}
async function setSetting(env, key, value) {
  await env.DB.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(key, value, now()).run();
}
async function delSetting(env, key) { await env.DB.prepare('DELETE FROM settings WHERE key=?').bind(key).run(); }
function maskSecret(value) {
  const v = String(value || '');
  if (!v) return '';
  if (v.length <= 10) return '****';
  return `${v.slice(0, 4)}${'*'.repeat(Math.min(12, v.length - 8))}${v.slice(-4)}`;
}
async function secretState(env) {
  const dbKey = await getSetting(env, 'yirenfu_api_key');
  const dbHook = await getSetting(env, 'yirenfu_webhook_secret');
  return {
    apiKeySource: dbKey ? 'database' : (env.YIRENFU_API_KEY ? 'secret' : 'none'),
    apiKeyMasked: maskSecret(dbKey || env.YIRENFU_API_KEY),
    webhookSecretSource: dbHook ? 'database' : (env.YIRENFU_WEBHOOK_SECRET ? 'secret' : 'none'),
    webhookSecretMasked: maskSecret(dbHook || env.YIRENFU_WEBHOOK_SECRET),
    storageConfigured: Boolean(env.BUCKET),
  };
}
async function apiKeyValue(env) { return (await getSetting(env, 'yirenfu_api_key')) || env.YIRENFU_API_KEY || ''; }
async function webhookSecretValue(env) { return (await getSetting(env, 'yirenfu_webhook_secret')) || env.YIRENFU_WEBHOOK_SECRET || ''; }
async function audit(env, action, target = '', detail = '') {
  try { await env.DB.prepare('INSERT INTO admin_audit(id,action,target,detail,created_at) VALUES(?,?,?,?,?)').bind(id('aud_'), action, target, detail, now()).run(); } catch {}
}
async function listUsers(env, url, currentAdminId) {
  const q = String(url.searchParams.get('q') || '').trim().slice(0, 64);
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || 20) || 20));
  const offset = Math.max(0, Math.min(100000, Number(url.searchParams.get('offset') || 0) || 0));
  const filter = q ? "WHERE u.email LIKE ? ESCAPE '\\'" : '';
  const args = q ? [`%${q.replace(/[\\%_]/g, m => `\\${m}`)}%`] : [];
  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS c FROM users u ${filter}`).bind(...args).first();
  const rows = await env.DB.prepare(
    `SELECT u.id, u.email, u.role, u.created_at, u.last_login_at, COALESCE(u.disabled,0) AS disabled,
       (SELECT COUNT(*) FROM sessions s WHERE s.user_id=u.id AND s.expires_at > ?) AS sessions,
       (SELECT COUNT(*) FROM purchase_intents p WHERE p.user_id=u.id) AS purchases,
       (SELECT COUNT(*) FROM orders o WHERE o.user_id=u.id AND o.status='DELIVERED') AS orders,
       COALESCE((SELECT balance FROM bonus_wallets w WHERE w.user_id=u.id),0) AS bonus_points
     FROM users u ${filter} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`
  ).bind(Math.floor(Date.now() / 1000), ...args, limit, offset).all();
  return { total: totalRow?.c || 0, limit, offset, current_user_id: currentAdminId, items: rows.results || [] };
}
async function yirenfu(env, path, method = 'GET', payload) {
  const key = await apiKeyValue(env);
  if (!key) throw Object.assign(new Error('服务端尚未配置一人付 API Key'), { status: 503, code: 'YIRENFU_KEY_MISSING' });
  const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
  if (payload !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${API}${path}`, { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
  let data;
  try { data = await response.json(); } catch { data = { error: '一人付返回了无法解析的响应', error_code: 'INVALID_UPSTREAM_RESPONSE' }; }
  return { response, data };
}
async function relayUpstream(env, path, method = 'GET', payload) {
  try {
    const { response, data } = await yirenfu(env, path, method, payload);
    return json(data, response.status, { 'x-upstream-request-id': response.headers.get('X-Request-ID') || data.request_id || '' });
  } catch (e) { return fail(e.status || 502, e.message || '一人付服务暂不可用', e.code || 'UPSTREAM_ERROR'); }
}
async function yirenfuProduct(env) {
  const result = await yirenfu(env, '/product');
  if (!result.response.ok) throw Object.assign(new Error(result.data.error || '读取套餐失败'), { status: result.response.status, code: result.data.error_code || 'UPSTREAM_ERROR' });
  return result.data;
}
async function checkCapability(env, capability) {
  const result = await yirenfu(env, '/capabilities');
  if (!result.response.ok) return json(result.data, result.response.status);
  if (result.data?.capabilities?.[capability] !== true) return json({ error: '一人付当前未开放此能力', error_code: 'CAPABILITY_NOT_AVAILABLE', capability }, 501);
  return null;
}
async function config(env) {
  const rows = await env.DB.prepare('SELECT key,value FROM settings').all();
  const saved = Object.fromEntries((rows.results || []).map(r => [r.key, r.value]));
  return {
    siteName: saved.siteName || env.SITE_NAME || '云端积分商店',
    description: saved.description || env.SITE_DESCRIPTION || '支付宝安全充值积分 · 积分兑换数字商品',
    pointsUnit: saved.pointsUnit || '积分',
  };
}

/* ---------------- 积分核销（一人付 /access + /consume 幂等） ---------------- */

async function saveLedger(env, key, result, token) {
  try {
    await env.DB.prepare("UPDATE consumption_jobs SET status=?,response_json=?,updated_at=? WHERE idempotency_key=? AND EXISTS (SELECT 1 FROM orders WHERE idempotency_key=? AND status='PENDING' AND processing_token=?)")
      .bind(result.status || 'UNKNOWN', JSON.stringify(result), now(), key, key, token).run();
  } catch {}
}
function pendingConsumption(key, message = '积分扣减结果待确认，请稍后同步订单') {
  return { state: 'PENDING', response: json({ business_id: key, delivered: false, message }, 202) };
}

function consumptionResult(key, result) {
  if (result.status === 'SUCCEEDED' && result.confirmed === true) return { state: 'DONE', result };
  if (['FAILED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(result.status)) {
    return { state: 'FAILED', response: json({ consumption: result, business_id: key, error: '积分扣减未成功', error_code: 'CONSUME_FAILED' }, 409) };
  }
  return pendingConsumption(key);
}

async function consumePoints(env, user, key, amount, reason, token) {
  let ledger = await env.DB.prepare('SELECT * FROM consumption_jobs WHERE idempotency_key=?').bind(key).first();
  if (ledger) {
    if (ledger.user_id !== user.id || Number(ledger.amount) !== amount || ledger.reason !== reason) {
      // An unrelated upstream request may already exist; never refund a potentially consumed order.
      return pendingConsumption(key, '原扣减记录参数不一致，请联系管理员核对');
    }
    let saved = {};
    try { saved = JSON.parse(ledger.response_json || '{}'); } catch {}
    if (saved.status === 'SUCCEEDED' && saved.confirmed === true || ['FAILED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(saved.status)) {
      return consumptionResult(key, saved);
    }
    // CREATED is a legacy state and may already have been sent before a crash.
    // SUBMITTED/UNKNOWN/PROCESSING are also ambiguous: only query the original ID.
    if (ledger.status !== 'PREPARING') {
      const prior = await yirenfu(env, '/consumption', 'POST', { user_id: user.id, idempotency_key: key }).catch(() => null);
      if (!prior?.response.ok) return pendingConsumption(key);
      await saveLedger(env, key, prior.data, token);
      return consumptionResult(key, prior.data);
    }
  } else {
    try {
      await env.DB.prepare('INSERT INTO consumption_jobs(idempotency_key,user_id,amount,reason,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .bind(key, user.id, amount, reason, 'PREPARING', now(), now()).run();
    } catch { return pendingConsumption(key); }
  }

  // No upstream debit has been sent in PREPARING; failures here can safely release the reservation.
  try {
    const capResp = await checkCapability(env, 'entitlement_query');
    if (capResp) return { state: 'ERROR', definitive: true, response: capResp };
    const access = await yirenfu(env, '/access', 'POST', { user_id: user.id });
    if (!access.response.ok) return { state: 'ERROR', definitive: true, response: json({ error: access.data.error || '积分查询失败', error_code: access.data.error_code || 'ACCESS_FAILED' }, access.response.status) };
    const a = access.data;
    if (!a.requires_consumption) return { state: 'FAILED', response: json({ error: '一人付当前不是积分/次数模式，赠送积分不足时无法兑换。', error_code: 'BILLING_MODE_NOT_QUOTA', billing_mode: a.billing_mode || null }, 409) };
    if (a.access_granted !== true || (typeof a.remaining === 'number' && a.remaining < amount)) {
      return { state: 'FAILED', response: json({ error: `支付宝积分不足：还需 ${amount}，当前剩余 ${a.remaining ?? 0}。`, error_code: 'POINTS_INSUFFICIENT', required: amount, remaining: a.remaining ?? 0 }, 402) };
    }
    const cap = await checkCapability(env, 'consumption');
    if (cap) return { state: 'ERROR', definitive: true, response: cap };
  } catch (e) {
    return { state: 'ERROR', definitive: true, response: fail(e.status || 503, e.message || '查询积分失败', e.code || 'UPSTREAM_ERROR') };
  }

  // Persist the intent before the network call. Once submitted, errors are ambiguous:
  // retain both stock and bonus reservation until the original result is confirmed.
  const submitted = await env.DB.prepare("UPDATE consumption_jobs SET status='SUBMITTED',updated_at=? WHERE idempotency_key=? AND status='PREPARING' AND EXISTS (SELECT 1 FROM orders WHERE idempotency_key=? AND status='PENDING' AND processing_token=? AND processing_until>=?)")
    .bind(now(), key, key, token, Math.floor(Date.now() / 1000)).run();
  if (!Number(submitted.meta?.changes || 0)) return pendingConsumption(key, '订单处理权已变更，请稍后同步');
  let used;
  try { used = await yirenfu(env, '/consume', 'POST', { user_id: user.id, idempotency_key: key, amount, reason }); }
  catch { return pendingConsumption(key); }
  if (!used.response.ok) return pendingConsumption(key);
  await saveLedger(env, key, used.data, token);
  return consumptionResult(key, used.data);
}

/* ---------------- 商品与订单 ---------------- */

function parseTags(value) {
  let raw;
  if (Array.isArray(value)) raw = value;
  else {
    const text = String(value ?? '').trim();
    if (text.startsWith('[')) {
      try { raw = JSON.parse(text); } catch { raw = []; }
    } else raw = text.split(/[,，]/);
  }
  if (!Array.isArray(raw)) raw = [];
  const tags = [];
  const seen = new Set();
  for (const item of raw) {
    const tag = String(item ?? '').trim().slice(0, 24);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= MAX_PRODUCT_TAGS) break;
  }
  return tags;
}

async function categoryAndChildren(env, categoryId) {
  if (!categoryId) return [];
  const rows = await env.DB.prepare('SELECT id,parent_id FROM categories').all();
  const children = new Map();
  for (const row of rows.results || []) {
    if (!row.parent_id) continue;
    if (!children.has(row.parent_id)) children.set(row.parent_id, []);
    children.get(row.parent_id).push(row.id);
  }
  const ids = [categoryId];
  for (let i = 0; i < ids.length; i++) {
    for (const childId of children.get(ids[i]) || []) {
      if (!ids.includes(childId)) ids.push(childId);
    }
  }
  return ids;
}

async function publicCategories(env) {
  const rows = await env.DB.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id=c.id AND p.status='ACTIVE') AS direct_count
     FROM categories c ORDER BY c.sort_order DESC, c.created_at ASC`
  ).all();
  const all = rows.results || [];
  const activeTop = new Set(all.filter(c => !c.parent_id && c.status === 'ACTIVE').map(c => c.id));
  const items = all
    .filter(c => c.status === 'ACTIVE' && (!c.parent_id || activeTop.has(c.parent_id)))
    .map(c => ({ ...c, product_count: Number(c.direct_count || 0) }));
  const counts = new Map(items.map(c => [c.id, c.product_count]));
  for (const c of items) {
    if (!c.parent_id) continue;
    counts.set(c.parent_id, (counts.get(c.parent_id) || 0) + c.product_count);
  }
  return { items: items.map(({ direct_count, ...c }) => ({ ...c, product_count: counts.get(c.id) || 0 })) };
}

async function listAdminCategories(env) {
  const rows = await env.DB.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id=c.id) AS product_count
     FROM categories c ORDER BY c.sort_order DESC, c.created_at ASC`
  ).all();
  return { items: rows.results || [] };
}

function parseCategory(b) {
  const name = String(b.name ?? '').trim();
  const parentId = String(b.parent_id ?? '').trim();
  const status = String(b.status ?? 'ACTIVE').toUpperCase();
  const sort = Number(b.sort_order ?? 0);
  if (name.length < 1 || name.length > 40) return { ok: false, error: '分类名称需为 1-40 个字符' };
  if (parentId && !/^cat_[A-Za-z0-9\-]{1,60}$/.test(parentId)) return { ok: false, error: '父分类编号无效' };
  if (!CATEGORY_STATUS.has(status)) return { ok: false, error: '分类状态只能是 ACTIVE / HIDDEN' };
  if (!Number.isInteger(sort) || sort < -9999 || sort > 9999) return { ok: false, error: '分类排序需为整数' };
  return { ok: true, value: { name, parent_id: parentId || null, status, sort_order: sort } };
}

async function validateCategoryParent(env, parentId, selfId = '') {
  if (!parentId) return null;
  if (selfId && parentId === selfId) return '分类不能以自己作为父分类';
  const parent = await env.DB.prepare('SELECT id,parent_id FROM categories WHERE id=?').bind(parentId).first();
  if (!parent) return '父分类不存在';
  if (parent.parent_id) return '只支持两级分类，不能把子分类作为父分类';
  if (selfId) {
    const children = await env.DB.prepare('SELECT COUNT(*) AS c FROM categories WHERE parent_id=?').bind(selfId).first();
    if (Number(children?.c || 0) > 0) return '该分类下已有子分类，不能改为子分类';
  }
  return null;
}

async function productCategoryOk(env, categoryId) {
  if (!categoryId) return true;
  return Boolean(await env.DB.prepare('SELECT id FROM categories WHERE id=?').bind(categoryId).first());
}

function storedPreview(value) {
  try {
    const parsed = normalizePreview(JSON.parse(value || '[]'));
    return parsed.ok ? parsed.items : [];
  } catch { return []; }
}

function publicProduct(p) {
  const provider = p.delivery_type === 'LINK' ? detectNetdisk(p.delivery_url) : null;
  return {
    id: p.id,
    title: p.title,
    summary: p.summary,
    description: p.description,
    price_points: p.price_points,
    cover_url: p.cover_url,
    category_id: p.category_id || '',
    tags: providerTags(parseTags(p.tags), p.delivery_type, p.delivery_url, MAX_PRODUCT_TAGS),
    provider: provider ? { id: provider.id, label: provider.label } : null,
    preview_files: Array.isArray(p.preview_files) ? p.preview_files : storedPreview(p.preview_files),
    preview_source: p.preview_source || '',
    preview_updated_at: p.preview_updated_at || null,
    preview_truncated: Boolean(p.preview_truncated),
    delivery_type: p.delivery_type,
    delivery_label: ({ TEXT: '文本内容', LINK: '下载链接', FILE: '文件下载' })[p.delivery_type] || '数字交付',
    stock: p.stock,
    sold_count: p.sold_count,
    status: p.status,
    sort_order: p.sort_order,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}
function orderView(o) {
  return {
    key: o.idempotency_key,
    order_no: o.order_no,
    product_id: o.product_id,
    title: o.title,
    price_points: o.price_points,
    bonus_points_used: Number(o.bonus_points_used || 0),
    onepay_points_used: Number(o.price_points) - Number(o.bonus_points_used || 0),
    status: o.status,
    delivery_type: o.delivery_type,
    created_at: o.created_at,
    delivered_at: o.delivered_at,
  };
}
function orderDelivery(o) {
  if (o.delivery_type === 'TEXT') return { type: 'TEXT', text: o.delivery_text };
  if (o.delivery_type === 'LINK') return { type: 'LINK', url: o.delivery_url };
  return {
    type: 'FILE',
    file: {
      name: o.file_name || '下载文件',
      download_path: `/api/download/${encodeURIComponent(o.idempotency_key)}`,
    },
  };
}
async function finalizeOrder(env, key, token) {
  await env.DB.prepare("UPDATE orders SET status='DELIVERED', delivered_at=? WHERE idempotency_key=? AND status='PENDING' AND processing_token=?").bind(now(), key, token).run();
  return env.DB.prepare('SELECT * FROM orders WHERE idempotency_key=?').bind(key).first();
}
function orderNo() {
  const t = Date.now().toString(36).toUpperCase();
  const r = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `NO${t}${r}`;
}
function parseProduct(b) {
  const title = String(b.title ?? '').trim();
  const summary = String(b.summary ?? '').trim();
  const description = String(b.description ?? '').trim();
  const price = Number(b.price_points);
  const cover = String(b.cover_url ?? '').trim();
  const categoryId = String(b.category_id ?? '').trim();
  const rawTags = parseTags(b.tags);
  const type = String(b.delivery_type ?? 'TEXT').toUpperCase();
  const text = String(b.delivery_text ?? '');
  const link = String(b.delivery_url ?? '').trim();
  const tags = providerTags(rawTags, type, link, MAX_PRODUCT_TAGS);
  const preview = normalizePreview(type === 'LINK' ? b.preview_files : undefined);
  const source = ['quark', 'baidu'].includes(b.preview_source) && detectNetdisk(link)?.id === b.preview_source ? b.preview_source : 'manual';
  const fileKey = String(b.file_key ?? '').trim();
  const fileName = String(b.file_name ?? '').trim();
  const status = String(b.status ?? 'ACTIVE').toUpperCase();
  const sort = Number(b.sort_order ?? 0);
  let stock = b.stock;
  if (stock === '' || stock === null || stock === undefined) stock = null;
  else stock = Number(stock);

  if (!preview.ok) return preview;
  if (title.length < 1 || title.length > 80) return { ok: false, error: '商品名称需为 1-80 个字符' };
  if (summary.length > 200) return { ok: false, error: '副标题最多 200 个字符' };
  if (description.length > 4000) return { ok: false, error: '商品详情最多 4000 个字符' };
  if (!Number.isInteger(price) || price < 1 || price > 99999999) return { ok: false, error: '积分价格需为 1-99999999 的整数' };
  if (cover && (cover.length > 500 || !(httpUrl(cover) || cover.startsWith('/')))) return { ok: false, error: '封面地址需为 http(s) 链接或以 / 开头的站内路径' };
  if (categoryId && !/^cat_[A-Za-z0-9\-]{1,60}$/.test(categoryId)) return { ok: false, error: '商品分类编号无效' };
  if (!DELIVERY_TYPES.has(type)) return { ok: false, error: '交付方式只能是 TEXT / LINK / FILE' };
  if (type === 'TEXT' && (text.trim().length < 1 || text.length > 20000)) return { ok: false, error: '文本交付内容需为 1-20000 个字符' };
  if (type === 'LINK' && (link.length < 1 || link.length > 2000 || !httpUrl(link))) return { ok: false, error: '链接交付内容需为有效的 http(s) 链接（如网盘链接）' };
  if (type === 'FILE' && (fileKey.length < 1 || fileKey.length > 512)) return { ok: false, error: '文件交付需要先上传文件或填写已上传文件的存储 key' };
  if (!PRODUCT_STATUS.has(status)) return { ok: false, error: '状态只能是 ACTIVE / HIDDEN' };
  if (!Number.isInteger(sort) || sort < -9999 || sort > 9999) return { ok: false, error: '排序需为整数' };
  if (stock !== null && (!Number.isInteger(stock) || stock < 0 || stock > 9999999)) return { ok: false, error: '库存需为 0-9999999 的整数，留空表示不限' };

  return {
    ok: true,
    value: {
      title, summary, description, price_points: price, cover_url: cover,
      category_id: categoryId || null, tags,
      preview_files: preview.items, preview_source: preview.items.length ? source : '',
      preview_truncated: preview.items.length && Boolean(b.preview_truncated) ? 1 : 0,
      delivery_type: type,
      delivery_text: type === 'TEXT' ? text : '',
      delivery_url: type === 'LINK' ? link : '',
      file_key: type === 'FILE' ? fileKey : '',
      file_name: type === 'FILE' ? (fileName || fileKey.split('/').pop() || '下载文件').slice(0, 120) : '',
      stock, status, sort_order: sort,
    },
  };
}

async function listProducts(env, all = false, q = '', categoryId = '', tags = []) {
  q = String(q || '').trim().slice(0, 64);
  categoryId = String(categoryId || '').trim().slice(0, 64);
  tags = Array.isArray(tags) ? tags : (tags ? [String(tags).trim().slice(0, 24)] : []);
  const where = [];
  const args = [];
  if (!all) where.push("status='ACTIVE'");
  if (q) { where.push("(title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')"); const like = `%${q.replace(/[\\%_]/g, m => `\\${m}`)}%`; args.push(like, like); }
  if (categoryId) {
    const ids = await categoryAndChildren(env, categoryId);
    if (!ids.length) return { items: [] };
    where.push(`category_id IN (${ids.map(() => '?').join(',')})`);
    args.push(...ids);
  }
  const sql = `SELECT * FROM products ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY sort_order DESC, created_at DESC LIMIT 200`;
  const rows = await env.DB.prepare(sql).bind(...args).all();
  let items = (rows.results || []).map(p => ({ ...p,
    tags: providerTags(parseTags(p.tags), p.delivery_type, p.delivery_url, MAX_PRODUCT_TAGS),
    preview_files: storedPreview(p.preview_files),
  }));
  if (tags.length) items = items.filter(p => tags.every(tag => p.tags.includes(tag)));
  return { items: all ? items : items.map(publicProduct) };
}

async function processOrder(env, user, order, request) {
  const key = order.idempotency_key, token = crypto.randomUUID();
  const lock = await env.DB.prepare("UPDATE orders SET processing_token=?,processing_until=? WHERE idempotency_key=? AND status='PENDING' AND (processing_token IS NULL OR processing_until<?)")
    .bind(token, Math.floor(Date.now() / 1000) + 300, key, Math.floor(Date.now() / 1000)).run();
  if (!Number(lock.meta?.changes || 0)) return { finished: false, response: json({ order: orderView(order), delivered: false, message: '订单正在处理，请稍后同步' }, 202) };
  try {
    order = await env.DB.prepare('SELECT * FROM orders WHERE idempotency_key=?').bind(key).first();
    const external = Number(order.price_points) - Number(order.bonus_points_used || 0);
    let consumed = { state: 'DONE' };
    if (external > 0) consumed = await consumePoints(env, user, key, external, `兑换 ${order.title}`, token);
    if (consumed.state === 'FAILED' || (consumed.state === 'ERROR' && consumed.definitive)) {
      const changed = await refundOrder(env, key, token);
      if (!changed) return { finished: false, response: pendingConsumption(key, '订单处理权已变更，请稍后同步').response };
      if (changed) await invalidatePublicCache(request, ['catalog']);
      return { finished: changed, response: consumed.response };
    }
    if (consumed.state !== 'DONE') return { finished: false, response: consumed.response };
    const done = await finalizeOrder(env, key, token);
    if (!done || done.status !== 'DELIVERED') return { finished: false, response: pendingConsumption(key, '订单处理权已变更，请稍后同步').response };
    return { finished: true, response: json({ order: orderView(done), delivery: orderDelivery(done), delivered: true }) };
  } catch {
    return { finished: false, response: fail(503, '积分扣减状态未知，订单保持待确认，可在「我的已购」稍后同步', 'CONSUME_UNKNOWN') };
  } finally {
    await env.DB.prepare('UPDATE orders SET processing_token=NULL,processing_until=0 WHERE idempotency_key=? AND processing_token=?').bind(key, token).run().catch(() => {});
  }
}

async function purchaseProduct(request, env, productId) {
  const user = await requireUser(request, env);
  const body = await bodyJson(request);
  const key = body.idempotency_key;
  if (!validText(key, 1, 128)) return fail(400, '购买编号无效', 'INVALID_ARGUMENT');
  let order = await env.DB.prepare('SELECT * FROM orders WHERE idempotency_key=?').bind(key).first();
  if (!order) {
    const p = await env.DB.prepare('SELECT * FROM products WHERE id=?').bind(productId).first();
    if (!p) return fail(404, '商品不存在', 'PRODUCT_NOT_FOUND');
    if (p.status !== 'ACTIVE') return fail(409, '该商品已下架', 'PRODUCT_UNAVAILABLE');
    try {
      if (!await reserveOrder(env, { productId, userId: user.id, key, orderNo: orderNo() })) {
        // The same key may have reserved the last item between the first read and this batch.
        order = await env.DB.prepare('SELECT * FROM orders WHERE idempotency_key=?').bind(key).first();
        if (!order) {
          const pending = await env.DB.prepare("SELECT idempotency_key FROM orders WHERE user_id=? AND product_id=? AND status='PENDING' LIMIT 1").bind(user.id, productId).first();
          if (pending) return fail(409, '该商品已有待确认订单，请先在「我的已购」同步，避免重复扣分', 'ORDER_ALREADY_PENDING');
          await invalidatePublicCache(request, ['catalog']);
          return fail(409, '该商品已售罄或暂不可兑换', 'OUT_OF_STOCK');
        }
      } else {
        await invalidatePublicCache(request, ['catalog']);
      }
    } catch {
      // A duplicate request rolls back its whole D1 transaction before reading the existing order.
      order = await env.DB.prepare('SELECT * FROM orders WHERE idempotency_key=?').bind(key).first();
      if (!order) return fail(409, '创建订单失败，请重试', 'ORDER_CREATE_FAILED');
    }
    if (!order) order = await env.DB.prepare('SELECT * FROM orders WHERE idempotency_key=?').bind(key).first();
  }
  if (order.user_id !== user.id || order.product_id !== productId) return fail(409, '购买编号已关联其他订单', 'IDEMPOTENCY_CONFLICT');
  if (order.status === 'DELIVERED') return json({ order: orderView(order), delivery: orderDelivery(order), already_delivered: true });
  if (order.status === 'FAILED') return fail(409, '该订单已失败，请重新发起兑换', 'ORDER_FAILED');
  return (await processOrder(env, user, order, request)).response;
}

async function listOrders(env, user, limit = 50) {
  const rows = await env.DB.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT ?').bind(user.id, limit).all();
  return (rows.results || []).map(o => ({
    ...orderView(o),
    delivery: o.status === 'DELIVERED' ? orderDelivery(o) : null,
  }));
}

async function syncOrders(env, user, request) {
  const rows = await env.DB.prepare("SELECT * FROM orders WHERE user_id=? AND status='PENDING' ORDER BY created_at DESC LIMIT 5").bind(user.id).all();
  let synced = 0;
  for (const order of rows.results || []) {
    const result = await processOrder(env, user, order, request);
    if (result.finished) synced++;
  }
  return synced;
}

async function downloadOrderFile(request, env, key) {
  const user = await requireUser(request, env);
  const order = await env.DB.prepare('SELECT * FROM orders WHERE idempotency_key=?').bind(key).first();
  if (!order || order.user_id !== user.id) return fail(404, '订单不存在', 'ORDER_NOT_FOUND');
  if (order.status !== 'DELIVERED') return fail(403, '订单尚未完成交付', 'ORDER_NOT_DELIVERED');
  if (order.delivery_type !== 'FILE' || !order.file_key) return fail(404, '该订单不包含文件', 'NO_FILE');
  if (!env.BUCKET) return fail(503, '服务端尚未绑定对象存储（R2），请联系管理员', 'STORAGE_NOT_CONFIGURED');
  const obj = await env.BUCKET.get(order.file_key);
  if (!obj) return fail(404, '文件已不存在，请联系管理员重新上传', 'FILE_MISSING');
  const name = order.file_name || 'download';
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'content-length': String(obj.size),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

async function uploadFile(request, env, source = 'goods') {
  if (!env.BUCKET) return fail(503, '尚未绑定 Cloudflare R2 存储桶。请在 wrangler.toml 增加 r2_buckets 绑定后重新部署。', 'STORAGE_NOT_CONFIGURED');
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_UPLOAD_BYTES + 1024 * 1024) return fail(413, '单个文件不能超过 50MB', 'FILE_TOO_LARGE');
  let form;
  try { form = await request.formData(); } catch { return fail(400, '请使用 multipart/form-data 上传文件', 'INVALID_ARGUMENT'); }
  const file = form.get('file');
  if (!file || typeof file === 'string') return fail(400, '缺少上传文件', 'INVALID_ARGUMENT');
  if (file.size > MAX_UPLOAD_BYTES) return fail(413, '单个文件不能超过 50MB', 'FILE_TOO_LARGE');
  if (file.size === 0) return fail(400, '文件内容为空', 'INVALID_ARGUMENT');
  const safeName = String(file.name || 'file').replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').slice(-80) || 'file';
  const key = `${source}/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${safeName}`;
  await env.BUCKET.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
    customMetadata: { originalName: encodeURIComponent(safeName), source },
  });
  await audit(env, source === 'agent' ? 'agent.file_uploaded' : 'goods.file_uploaded', key, `${file.size} bytes`);
  return json({ ok: true, key, name: safeName, size: file.size, type: file.type || '' });
}

// Agent credentials have no admin or publishing privileges. The secret never
// enters D1, URLs, public responses, or audit logs.
async function requireAgent(request, env) {
  const secret = String(env.AGENT_API_TOKEN || '');
  if (secret.length < 32) throw Object.assign(new Error('Agent 接口未配置安全令牌'), { status: 503, code: 'AGENT_NOT_CONFIGURED' });
  const match = (request.headers.get('authorization') || '').match(/^Bearer ([^\s]{1,512})$/i);
  const candidate = match?.[1] || '';
  if (!constantEq(await sha256(candidate), await sha256(secret))) {
    throw Object.assign(new Error('Agent 令牌无效'), { status: 401, code: 'AGENT_UNAUTHORIZED' });
  }
}

function agentProductView(product) {
  return { id: product.id, title: product.title, status: product.status, price_points: product.price_points, created_at: product.created_at };
}

async function createAgentDraft(request, env) {
  if (!env.BUCKET) return fail(503, '尚未绑定 R2 存储', 'STORAGE_NOT_CONFIGURED');
  const body = await bodyJson(request);
  const operation = String(body.idempotency_key || '').trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(operation)) return fail(400, '幂等编号需为 8–128 位字母、数字、下划线或连字符', 'INVALID_ARGUMENT');
  const key = String(body.file_key || '').trim();
  if (!/^agent\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9_-]{20,80}-[^/]{1,80}$/.test(key)) return fail(400, '只能关联 Agent 上传的文件', 'INVALID_FILE_KEY');
  const parsed = parseProduct({
    title: body.title, summary: body.summary, description: body.description,
    price_points: body.price_points, category_id: body.category_id, tags: body.tags,
    file_key: key, file_name: body.file_name, delivery_type: 'FILE', status: 'HIDDEN',
    stock: body.stock, sort_order: 0,
  });
  if (!parsed.ok) return fail(400, parsed.error, 'INVALID_ARGUMENT');
  const v = parsed.value;
  const hash = await sha256(JSON.stringify(v));
  async function existingResult() {
    const job = await env.DB.prepare('SELECT * FROM agent_product_jobs WHERE idempotency_key=?').bind(operation).first();
    if (!job) return null;
    if (!constantEq(job.payload_hash, hash)) return fail(409, '该幂等编号已关联不同内容', 'IDEMPOTENCY_CONFLICT');
    const product = await env.DB.prepare('SELECT id,title,status,price_points,created_at FROM products WHERE id=?').bind(job.product_id).first();
    return product ? json({ ok: true, product: agentProductView(product), already_created: true })
      : fail(410, '对应草稿已删除，请使用新的幂等编号', 'DRAFT_REMOVED');
  }
  const previous = await existingResult();
  if (previous) return previous;
  if (!await productCategoryOk(env, v.category_id)) return fail(400, '所选商品分类不存在', 'CATEGORY_NOT_FOUND');
  const object = await env.BUCKET.head(key);
  if (!object || object.customMetadata?.source !== 'agent') return fail(404, '未找到 Agent 上传的文件', 'FILE_NOT_FOUND');
  const pid = id('prd_'); const created = now();
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO agent_product_jobs(idempotency_key,payload_hash,product_id,created_at) VALUES(?,?,?,?)').bind(operation, hash, pid, created),
      env.DB.prepare(`INSERT INTO products(id,title,summary,description,price_points,cover_url,category_id,tags,delivery_type,delivery_text,delivery_url,file_key,file_name,stock,status,sort_order,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(pid, v.title, v.summary, v.description, v.price_points, '', v.category_id, JSON.stringify(v.tags), 'FILE', '', '', v.file_key, v.file_name, v.stock, 'HIDDEN', 0, created, created),
    ]);
  } catch {
    // Concurrent retries either see the same committed job or fail cleanly.
    const existing = await existingResult();
    if (existing) return existing;
    return fail(503, '创建草稿失败，请使用相同幂等编号重试', 'DRAFT_CREATE_FAILED');
  }
  await audit(env, 'agent.draft_created', pid, 'Agent 上传文件创建待审核草稿');
  return json({ ok: true, product: { id: pid, title: v.title, status: 'HIDDEN', price_points: v.price_points, created_at: created }, already_created: false }, 201);
}

async function generateCover(request, env) {
  if (!env.AI?.run) return fail(503, '尚未配置 Workers AI 绑定', 'AI_NOT_CONFIGURED');
  if (!env.BUCKET) return fail(503, '请先绑定 R2，以保存生成的封面', 'STORAGE_NOT_CONFIGURED');
  const body = await bodyJson(request);
  const prompt = String(body.prompt || '').trim();
  if (prompt.length < 3 || prompt.length > 500) return fail(400, '封面描述需为 3–500 个字符', 'INVALID_ARGUMENT');
  let image;
  try {
    const result = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', { prompt, steps: 4 });
    const encoded = result?.image;
    if (typeof encoded !== 'string' || encoded.length > 8 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('invalid image');
    const binary = atob(encoded);
    image = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) image[i] = binary.charCodeAt(i);
    if (image.length < 4 || image[0] !== 0xff || image[1] !== 0xd8 || image[2] !== 0xff) throw new Error('invalid jpeg');
  } catch {
    return fail(503, '封面生成失败，请检查 Workers AI 配额、模型可用性或稍后重试', 'AI_GENERATION_FAILED');
  }
  const coverId = crypto.randomUUID();
  await env.BUCKET.put(`covers/${coverId}.jpg`, image, { httpMetadata: { contentType: 'image/jpeg' } });
  await audit(env, 'goods.cover_generated', coverId, 'Workers AI 手动生成封面');
  return json({ ok: true, url: `/api/covers/${coverId}`, model: '@cf/black-forest-labs/flux-1-schnell' }, 201);
}

async function publicCover(env, coverId) {
  if (!env.BUCKET) return fail(404, '图片不存在', 'NOT_FOUND');
  const object = await env.BUCKET.get(`covers/${coverId}.jpg`);
  if (!object) return fail(404, '图片不存在', 'NOT_FOUND');
  return new Response(object.body, { headers: {
    'content-type': 'image/jpeg', 'content-length': String(object.size),
    'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff',
  } });
}

async function verifyWebhook(request, env, raw) {
  const secret = await webhookSecretValue(env);
  if (!secret) return false;
  const eventId = request.headers.get('Yirenfu-Event-ID') || '';
  const timestamp = request.headers.get('Yirenfu-Timestamp') || '';
  const signature = request.headers.get('Yirenfu-Signature') || '';
  if (!eventId || !/^\d{1,12}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !/^v1=[0-9a-f]{64}$/i.test(signature)) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${raw}`)));
  const hex = [...digest].map(b => b.toString(16).padStart(2, '0')).join('');
  if (!constantEq(signature.slice(3).toLowerCase(), hex)) return false;
  try { const parsed = JSON.parse(raw); return parsed.id === eventId ? parsed : false; } catch { return false; }
}

async function route(request, env, ctx) {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  if (method !== 'GET' && !originOk(request)) return fail(403, '请求来源校验失败', 'ORIGIN_REJECTED');
  if (path === '/api/health' && method === 'GET') {
    let apiKeyConfigured = Boolean(env.YIRENFU_API_KEY), webhookSecretConfigured = Boolean(env.YIRENFU_WEBHOOK_SECRET);
    try { apiKeyConfigured = Boolean(await apiKeyValue(env)); webhookSecretConfigured = Boolean(await webhookSecretValue(env)); } catch {}
    return json({ ok: true, apiKeyConfigured, webhookSecretConfigured, storageConfigured: Boolean(env.BUCKET) });
  }
  if (path === '/api/config' && method === 'GET') return cachedPublicJson(request, async () => json(await config(env)), ctx);
  if (path === '/api/product' && method === 'GET') return cachedPublicJson(request, async () => relayUpstream(env, '/product'), ctx);
  if (path === '/api/categories' && method === 'GET') return cachedPublicJson(request, async () => json(await publicCategories(env)), ctx);

  // Only generated cover images are public; product files remain order-protected.
  const coverMatch = path.match(/^\/api\/covers\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
  if (coverMatch && method === 'GET') return publicCover(env, coverMatch[1]);

  // The external agent can upload and create hidden drafts, never publish.
  if (path.startsWith('/api/agent/')) {
    await requireAgent(request, env);
    if (path === '/api/agent/uploads' && method === 'POST') return uploadFile(request, env, 'agent');
    if (path === '/api/agent/drafts' && method === 'POST') return createAgentDraft(request, env);
    return fail(404, 'Not Found', 'NOT_FOUND');
  }

  // 商品货架（公开）
  if (path === '/api/products' && method === 'GET') return cachedPublicJson(request, async () => json(await listProducts(
    env, false, url.searchParams.get('q'), url.searchParams.get('category'), productTagFilters(url.searchParams)
  )), ctx);
  const buyMatch = path.match(/^\/api\/products\/([A-Za-z0-9_\-]{1,64})\/purchase$/);
  if (buyMatch && method === 'POST') {
    return purchaseProduct(request, env, buyMatch[1]);
  }

  // 我的订单 / 已购内容
  if (path === '/api/orders' && method === 'GET') {
    const user = await requireUser(request, env);
    return json({ items: await listOrders(env, user) });
  }
  if (path === '/api/orders/sync' && method === 'POST') {
    const user = await requireUser(request, env);
    const synced = await syncOrders(env, user, request);
    return json({ ok: true, synced, items: await listOrders(env, user) });
  }
  const dlMatch = path.match(/^\/api\/download\/([A-Za-z0-9_\-]{1,128})$/);
  if (dlMatch && method === 'GET') return downloadOrderFile(request, env, dlMatch[1]);

  if (path === '/api/auth/me' && method === 'GET') {
    const user = await currentSession(request, env, 'user');
    return user ? json({ authenticated: true, user: { id: user.id, email: user.email, role: user.role } }) : json({ authenticated: false });
  }
  if (path === '/api/admin/me' && method === 'GET') {
    const user = await currentSession(request, env, 'admin');
    return user && user.role === 'admin'
      ? json({ authenticated: true, user: { id: user.id, email: user.email, role: user.role } })
      : json({ authenticated: false });
  }
  if (path === '/api/auth/register' && method === 'POST') {
    const b = await bodyJson(request); const email = String(b.email || '').trim().toLowerCase(); const password = b.password;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || typeof password !== 'string' || password.length < 10 || password.length > 128) return fail(400, '请输入有效邮箱和至少 10 位密码', 'INVALID_ARGUMENT');
    const uid = id('usr_');
    const existing = await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first();
    if (existing) return fail(409, '该邮箱已注册，请直接登录', 'EMAIL_EXISTS');
    try { await env.DB.prepare('INSERT INTO users(id,email,password_hash,created_at,updated_at) VALUES(?,?,?,?,?)').bind(uid, email, await passwordHash(password), now(), now()).run(); }
    catch (e) {
      if (/UNIQUE|constraint/i.test(String(e && e.message))) return fail(409, '该邮箱已注册，请直接登录', 'EMAIL_EXISTS');
      console.error('register_failed', String(e && e.message || e));
      return fail(500, `注册失败：${String(e && e.message || '数据库写入异常').slice(0, 160)}`, 'REGISTER_FAILED');
    }
    const session = await createSession(env, uid, 'user');
    return json({ ok: true, user: { id: uid, email } }, 201, { 'set-cookie': cookie(env.COOKIE_NAME || 'onepay_session', session.token, session.maxAge) });
  }
  if (path === '/api/auth/login' && method === 'POST') {
    const b = await bodyJson(request); const email = String(b.email || '').trim().toLowerCase();
    const account = await env.DB.prepare('SELECT id,email,password_hash,COALESCE(disabled,0) AS disabled FROM users WHERE email=?').bind(email).first();
    if (!account || !await passwordMatches(String(b.password || ''), account.password_hash)) return fail(401, '邮箱或密码不正确', 'LOGIN_FAILED');
    if (account.disabled) return fail(403, '该账号已被停用，请联系管理员', 'ACCOUNT_DISABLED');
    const session = await createSession(env, account.id, 'user');
    await env.DB.prepare('UPDATE users SET last_login_at=? WHERE id=?').bind(now(), account.id).run().catch(() => {});
    return json({ ok: true, user: { id: account.id, email: account.email } }, 200, { 'set-cookie': cookie(env.COOKIE_NAME || 'onepay_session', session.token, session.maxAge) });
  }
  if (path === '/api/admin/login' && method === 'POST') {
    const b = await bodyJson(request);
    const email = String(b.email || '').trim().toLowerCase();
    const account = await env.DB.prepare('SELECT id,email,password_hash,role,COALESCE(disabled,0) AS disabled FROM users WHERE email=?').bind(email).first();
    if (!account || !await passwordMatches(String(b.password || ''), account.password_hash)) return fail(401, '邮箱或密码不正确', 'LOGIN_FAILED');
    if (account.disabled) return fail(403, '该账号已被停用，请联系管理员', 'ACCOUNT_DISABLED');
    if (account.role !== 'admin') return fail(403, '该账号没有管理员权限', 'NOT_ADMIN');
    const session = await createSession(env, account.id, 'admin');
    await env.DB.prepare('UPDATE users SET last_login_at=? WHERE id=?').bind(now(), account.id).run().catch(() => {});
    await audit(env, 'admin.login', account.id, account.email);
    return json({ ok: true, user: { id: account.id, email: account.email, role: account.role } }, 200, { 'set-cookie': cookie(sessionCookieName(env, 'admin'), session.token, session.maxAge) });
  }
  if (path === '/api/auth/logout' && method === 'POST') {
    const raw = getCookie(request, sessionCookieName(env, 'user'));
    if (raw) await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256(raw)).run();
    return json({ ok: true }, 200, { 'set-cookie': cookie(sessionCookieName(env, 'user'), '', 0) });
  }
  if (path === '/api/admin/logout' && method === 'POST') {
    const raw = getCookie(request, sessionCookieName(env, 'admin'));
    if (raw) await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256(raw)).run();
    return json({ ok: true }, 200, { 'set-cookie': cookie(sessionCookieName(env, 'admin'), '', 0) });
  }
  if (path === '/api/access' && method === 'GET') {
    const user = await requireUser(request, env);
    const bonus = await bonusBalance(env, user.id);
    const used = await env.DB.prepare("SELECT COALESCE(SUM(bonus_points_used),0) AS used FROM orders WHERE user_id=? AND status='DELIVERED'").bind(user.id).first();
    const bonusUsed = Number(used?.used || 0);
    try {
      const unavailable = await checkCapability(env, 'entitlement_query');
      if (unavailable) return json({ bonus_points: bonus, bonus_used: bonusUsed, onepay_points: null, total_points: null, upstream_available: false, upstream_message: '支付宝积分暂不可用' });
      const result = await yirenfu(env, '/access', 'POST', { user_id: user.id });
      if (!result.response.ok) return json({ bonus_points: bonus, bonus_used: bonusUsed, onepay_points: null, total_points: null, upstream_available: false, upstream_message: '支付宝积分暂不可用' });
      const data = result.data;
      const onepay = data.requires_consumption
        ? (typeof data.remaining === 'number' && Number.isFinite(data.remaining) ? Math.max(0, data.remaining) : null)
        : 0;
      const spendable = onepay === null ? null : (data.access_granted === true ? onepay : 0);
      return json({ ...data, bonus_points: bonus, bonus_used: bonusUsed, onepay_points: onepay, total_points: spendable === null ? null : bonus + spendable, upstream_available: true });
    } catch {
      return json({ bonus_points: bonus, bonus_used: bonusUsed, onepay_points: null, total_points: null, upstream_available: false, upstream_message: '支付宝积分暂不可用' });
    }
  }
  if (path === '/api/purchase' && method === 'POST') return purchasePointsHandler(request, env);
  if (path === '/api/purchases' && method === 'GET') {
    const user = await requireUser(request, env);
    return relayUpstream(env, '/purchases/list', 'POST', { user_id: user.id, limit: 20 });
  }
  if (path === '/api/consumptions' && method === 'GET') {
    const user = await requireUser(request, env);
    const rows = await env.DB.prepare('SELECT idempotency_key,status,amount,reason,response_json,created_at FROM consumption_jobs WHERE user_id=? ORDER BY created_at DESC LIMIT 50').bind(user.id).all();
    return json({ items: (rows.results || []).map(r => ({ ...r, response: JSON.parse(r.response_json || '{}'), response_json: undefined })) });
  }

  if (path.startsWith('/api/admin/')) {
    const admin = await requireAdmin(request, env);
    if (path === '/api/admin/config' && method === 'GET') return json(await config(env));
    if (path === '/api/admin/config' && method === 'PUT') {
      const b = await bodyJson(request); const siteName = String(b.siteName || '').trim(); const description = String(b.description || '').trim();
      if (!siteName || siteName.length > 64 || !description || description.length > 240) return fail(400, '站点名称或描述长度无效', 'INVALID_ARGUMENT');
      await env.DB.batch(['siteName', 'description'].map((k, i) => env.DB.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(k, i ? description : siteName, now())));
      await invalidatePublicCache(request, ['site']);
      return json({ ok: true, siteName, description });
    }

    // 分类管理（一级分类 + 二级子分类）
    if (path === '/api/admin/categories' && method === 'GET') return json(await listAdminCategories(env));
    if (path === '/api/admin/categories' && method === 'POST') {
      const parsed = parseCategory(await bodyJson(request));
      if (!parsed.ok) return fail(400, parsed.error, 'INVALID_ARGUMENT');
      const v = parsed.value;
      const parentError = await validateCategoryParent(env, v.parent_id);
      if (parentError) return fail(400, parentError, 'INVALID_CATEGORY_PARENT');
      const cid = id('cat_');
      await env.DB.prepare('INSERT INTO categories(id,name,parent_id,sort_order,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .bind(cid, v.name, v.parent_id, v.sort_order, v.status, now(), now()).run();
      await audit(env, 'category.created', cid, `${v.name} / ${v.parent_id ? '子分类' : '顶级分类'}`);
      await invalidatePublicCache(request, ['catalog']);
      const row = await env.DB.prepare('SELECT * FROM categories WHERE id=?').bind(cid).first();
      return json({ ok: true, category: row }, 201);
    }
    const catRoute = path.match(/^\/api\/admin\/categories\/([A-Za-z0-9_\-]{1,64})$/);
    if (catRoute) {
      const cid = catRoute[1];
      const existing = await env.DB.prepare('SELECT * FROM categories WHERE id=?').bind(cid).first();
      if (!existing) return fail(404, '分类不存在', 'CATEGORY_NOT_FOUND');
      if (method === 'PUT') {
        const parsed = parseCategory(await bodyJson(request));
        if (!parsed.ok) return fail(400, parsed.error, 'INVALID_ARGUMENT');
        const v = parsed.value;
        const parentError = await validateCategoryParent(env, v.parent_id, cid);
        if (parentError) return fail(400, parentError, 'INVALID_CATEGORY_PARENT');
        await env.DB.prepare('UPDATE categories SET name=?,parent_id=?,sort_order=?,status=?,updated_at=? WHERE id=?')
          .bind(v.name, v.parent_id, v.sort_order, v.status, now(), cid).run();
        await audit(env, 'category.updated', cid, `${v.name} / ${v.status}`);
        await invalidatePublicCache(request, ['catalog']);
        const row = await env.DB.prepare('SELECT * FROM categories WHERE id=?').bind(cid).first();
        return json({ ok: true, category: row });
      }
      if (method === 'DELETE') {
        const children = await env.DB.prepare('SELECT COUNT(*) AS c FROM categories WHERE parent_id=?').bind(cid).first();
        if (Number(children?.c || 0) > 0) return fail(409, '该分类下还有子分类，请先处理子分类', 'CATEGORY_HAS_CHILDREN');
        const products = await env.DB.prepare('SELECT COUNT(*) AS c FROM products WHERE category_id=?').bind(cid).first();
        if (Number(products?.c || 0) > 0) return fail(409, '该分类下还有商品，请先调整商品分类', 'CATEGORY_HAS_PRODUCTS');
        await env.DB.prepare('DELETE FROM categories WHERE id=?').bind(cid).run();
        await audit(env, 'category.deleted', cid, existing.name);
        await invalidatePublicCache(request, ['catalog']);
        return json({ ok: true, deleted: true });
      }
    }

    if (path === '/api/admin/covers/generate' && method === 'POST') return generateCover(request, env);

    // The request is authenticated as an admin, and only fixed platform hosts are contacted.
    if (path === '/api/admin/netdisk/preview' && method === 'POST') {
      const body = await bodyJson(request);
      try { return json({ ok: true, ...await readShareDirectory(body.url, body.passcode) }); }
      catch (error) {
        return json({ error: error.message, error_code: 'NETDISK_PREVIEW_UNAVAILABLE', ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) }, 422);
      }
    }

    // 商品管理
    if (path === '/api/admin/products' && method === 'GET') return json(await listProducts(env, true, url.searchParams.get('q')));
    if (path === '/api/admin/products' && method === 'POST') {
      const parsed = parseProduct(await bodyJson(request));
      if (!parsed.ok) return fail(400, parsed.error, 'INVALID_ARGUMENT');
      const pid = id('prd_');
      const v = parsed.value;
      if (!await productCategoryOk(env, v.category_id)) return fail(400, '所选商品分类不存在', 'CATEGORY_NOT_FOUND');
      await env.DB.prepare(`INSERT INTO products(id,title,summary,description,price_points,cover_url,category_id,tags,delivery_type,delivery_text,delivery_url,file_key,file_name,stock,status,sort_order,created_at,updated_at,preview_files,preview_source,preview_updated_at,preview_truncated)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(pid, v.title, v.summary, v.description, v.price_points, v.cover_url, v.category_id, JSON.stringify(v.tags), v.delivery_type, v.delivery_text, v.delivery_url, v.file_key, v.file_name, v.stock, v.status, v.sort_order, now(), now(), JSON.stringify(v.preview_files), v.preview_source, v.preview_files.length ? now() : null, v.preview_truncated).run();
      await audit(env, 'goods.created', pid, `${v.title} / ${v.price_points} 积分`);
      await invalidatePublicCache(request, ['catalog']);
      const row = await env.DB.prepare('SELECT * FROM products WHERE id=?').bind(pid).first();
      return json({ ok: true, product: row }, 201);
    }
    const prodRoute = path.match(/^\/api\/admin\/products\/([A-Za-z0-9_\-]{1,64})$/);
    if (prodRoute) {
      const pid = prodRoute[1];
      const existing = await env.DB.prepare('SELECT * FROM products WHERE id=?').bind(pid).first();
      if (!existing) return fail(404, '商品不存在', 'PRODUCT_NOT_FOUND');
      if (method === 'PUT') {
        const body = await bodyJson(request);
        // Older clients may omit the preview. Preserve it only while the delivery
        // link is unchanged, so an old snapshot cannot silently describe a new share.
        if (!Object.hasOwn(body, 'preview_files') && String(body.delivery_url || '').trim() === existing.delivery_url) {
          body.preview_files = storedPreview(existing.preview_files);
          body.preview_source = existing.preview_source;
          body.preview_truncated = existing.preview_truncated;
        }
        const parsed = parseProduct(body);
        if (!parsed.ok) return fail(400, parsed.error, 'INVALID_ARGUMENT');
        const v = parsed.value;
        if (!await productCategoryOk(env, v.category_id)) return fail(400, '所选商品分类不存在', 'CATEGORY_NOT_FOUND');
        const samePreview = JSON.stringify(v.preview_files) === JSON.stringify(storedPreview(existing.preview_files)) &&
          v.preview_source === existing.preview_source && v.preview_truncated === Number(existing.preview_truncated || 0) && v.delivery_url === existing.delivery_url;
        const previewTime = v.preview_files.length ? (samePreview ? existing.preview_updated_at : now()) : null;
        await env.DB.prepare(`UPDATE products SET title=?,summary=?,description=?,price_points=?,cover_url=?,category_id=?,tags=?,delivery_type=?,delivery_text=?,delivery_url=?,file_key=?,file_name=?,stock=?,status=?,sort_order=?,updated_at=?,preview_files=?,preview_source=?,preview_updated_at=?,preview_truncated=? WHERE id=?`)
          .bind(v.title, v.summary, v.description, v.price_points, v.cover_url, v.category_id, JSON.stringify(v.tags), v.delivery_type, v.delivery_text, v.delivery_url, v.file_key, v.file_name, v.stock, v.status, v.sort_order, now(), JSON.stringify(v.preview_files), v.preview_source, previewTime, v.preview_truncated, pid).run();
        await audit(env, 'goods.updated', pid, `${v.title} / ${v.status}`);
        await invalidatePublicCache(request, ['catalog']);
        const row = await env.DB.prepare('SELECT * FROM products WHERE id=?').bind(pid).first();
        return json({ ok: true, product: row });
      }
      if (method === 'DELETE') {
        // Delete and the outstanding-order check are a single atomic statement:
        // a concurrent reservation either wins first and keeps the product, or sees it gone.
        const deleted = await env.DB.prepare("DELETE FROM products WHERE id=? AND NOT EXISTS (SELECT 1 FROM orders WHERE product_id=? AND status IN ('PENDING','DELIVERED'))").bind(pid, pid).run();
        if (!Number(deleted.meta?.changes || 0)) {
          await env.DB.prepare("UPDATE products SET status='HIDDEN',updated_at=? WHERE id=?").bind(now(), pid).run();
          await audit(env, 'goods.hidden', pid, '存在待确认或已完成订单，仅下架商品');
          await invalidatePublicCache(request, ['catalog']);
          return json({ ok: true, hidden: true, message: '该商品有待确认或已完成订单，已改为下架以保留订单。' });
        }
        await audit(env, 'goods.deleted', pid, existing.title);
        await invalidatePublicCache(request, ['catalog']);
        return json({ ok: true, deleted: true });
      }
    }
    if (path === '/api/admin/upload' && method === 'POST') return uploadFile(request, env);
    if (path === '/api/admin/storage' && method === 'GET') return json({ configured: Boolean(env.BUCKET), maxSize: MAX_UPLOAD_BYTES });
    if (path === '/api/admin/orders' && method === 'GET') {
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || 50) || 50));
      const rows = await env.DB.prepare(`SELECT o.*, u.email AS user_email FROM orders o LEFT JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC LIMIT ?`).bind(limit).all();
      return json({ items: (rows.results || []).map(o => ({ ...orderView(o), user_id: o.user_id, email: o.user_email || '' })) });
    }

    if (path === '/api/admin/capabilities' && method === 'GET') return relayUpstream(env, '/capabilities');
    if (path === '/api/admin/product' && method === 'GET') return relayUpstream(env, '/product');
    if (path === '/api/admin/purchases' && method === 'GET') {
      const unavailable = await checkCapability(env, 'purchase_request_list');
      if (unavailable) return unavailable;
      return relayUpstream(env, '/purchases/list', 'POST', { limit: 50 });
    }
    if (path === '/api/admin/consumptions' && method === 'GET') {
      const unavailable = await checkCapability(env, 'consumption_list');
      if (unavailable) return unavailable;
      return relayUpstream(env, '/consumptions/list', 'POST', { limit: 50 });
    }
    if (path === '/api/admin/events' && method === 'GET') {
      const unavailable = await checkCapability(env, 'webhooks');
      if (unavailable) return unavailable;
      return relayUpstream(env, '/events/list', 'POST', { limit: 50 });
    }
    if (path === '/api/admin/webhook' && (method === 'GET' || method === 'PUT') || path === '/api/admin/webhook/rotate' && method === 'POST') {
      const unavailable = await checkCapability(env, 'webhooks');
      if (unavailable) return unavailable;
    }
    if (path === '/api/admin/webhook' && method === 'GET') return relayUpstream(env, '/webhook');
    if (path === '/api/admin/webhook' && method === 'PUT') {
      const b = await bodyJson(request); const enabled = b.enabled === true;
      const hookUrl = `${url.origin}/api/webhook`;
      return relayUpstream(env, '/webhook', 'PUT', { url: hookUrl, enabled });
    }
    if (path === '/api/admin/webhook/rotate' && method === 'POST') return relayUpstream(env, '/webhook/rotate', 'POST');
    const retry = path.match(/^\/api\/admin\/events\/([^/]+)\/retry$/);
    if (retry && method === 'POST') {
      const unavailable = await checkCapability(env, 'webhooks');
      if (unavailable) return unavailable;
      return relayUpstream(env, `/events/${encodeURIComponent(retry[1])}/retry`, 'POST');
    }
    if (path === '/api/admin/status' && method === 'GET') {
      const state = await secretState(env);
      return json({ apiKeyConfigured: state.apiKeySource !== 'none', webhookSecretConfigured: state.webhookSecretSource !== 'none', databaseConfigured: Boolean(env.DB), ...state });
    }
    if (path === '/api/admin/security' && method === 'GET') return json(await secretState(env));
    if (path === '/api/admin/api-key' && method === 'POST') {
      const b = await bodyJson(request);
      if (b.clear === true) { await delSetting(env, 'yirenfu_api_key'); await audit(env, 'admin.api_key_cleared'); await invalidatePublicCache(request, ['plans']); return json({ ok: true, ...await secretState(env) }); }
      const value = typeof b.value === 'string' ? b.value.trim() : '';
      if (value.length < 8 || value.length > 200 || /\s/.test(value)) return fail(400, 'API Key 需为 8-200 位且不含空白字符', 'INVALID_ARGUMENT');
      await setSetting(env, 'yirenfu_api_key', value);
      await audit(env, 'admin.api_key_updated');
      await invalidatePublicCache(request, ['plans']);
      return json({ ok: true, ...await secretState(env) });
    }
    if (path === '/api/admin/webhook-secret' && method === 'POST') {
      const b = await bodyJson(request);
      if (b.clear === true) { await delSetting(env, 'yirenfu_webhook_secret'); await audit(env, 'admin.webhook_secret_cleared'); return json({ ok: true, ...await secretState(env) }); }
      const value = typeof b.value === 'string' ? b.value.trim() : '';
      if (value.length < 8 || value.length > 200 || /\s/.test(value)) return fail(400, '签名密钥需为 8-200 位且不含空白字符', 'INVALID_ARGUMENT');
      await setSetting(env, 'yirenfu_webhook_secret', value);
      await audit(env, 'admin.webhook_secret_updated');
      return json({ ok: true, ...await secretState(env) });
    }
    if (path === '/api/admin/users' && method === 'GET') return json(await listUsers(env, url, admin.id));
    if (path === '/api/admin/audit' && method === 'GET') {
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || 30) || 30));
      const rows = await env.DB.prepare('SELECT id,action,target,detail,created_at FROM admin_audit ORDER BY created_at DESC LIMIT ?').bind(limit).all();
      return json({ items: rows.results || [] });
    }
    const userRoute = path.match(/^\/api\/admin\/users\/([A-Za-z0-9_\-]{1,64})(?:\/(reset-password|status|role|bonus))?$/);
    if (userRoute) {
      const targetId = userRoute[1], action = userRoute[2] || '';
      const target = await env.DB.prepare('SELECT id,email,role FROM users WHERE id=?').bind(targetId).first();
      if (!target) return fail(404, '用户不存在', 'USER_NOT_FOUND');
      if (action === 'bonus' && method === 'GET') {
        return json({ bonus_points: await bonusBalance(env, targetId), items: await bonusHistory(env, targetId) });
      }
      if (action === 'bonus' && method === 'POST') {
        const b = await bodyJson(request);
        const delta = b.delta, reason = typeof b.reason === 'string' ? b.reason.trim() : '', key = b.idempotency_key;
        if (!Number.isSafeInteger(delta) || !delta || Math.abs(delta) > 100000000 || !validText(reason, 1, 120) || typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(key)) {
          return fail(400, '积分调整数量、原因或操作编号无效', 'INVALID_ARGUMENT');
        }
        const result = await adjustBonus(env, { userId: targetId, actorId: admin.id, delta, reason, key });
        if (!result.ok) return fail(409, result.code === 'BALANCE_LIMIT' ? '赠送积分不足或超过上限' : '操作编号已用于其他调整', result.code);
        return json(result);
      }
      if (action === 'role' && method === 'POST') {
        const b = await bodyJson(request);
        const role = String(b.role || '');
        if (!['user', 'admin'].includes(role)) return fail(400, '角色无效', 'INVALID_ARGUMENT');
        if (targetId === admin.id && role !== 'admin') return fail(400, '不能取消当前登录账号自己的管理员权限', 'SELF_DEMOTION_FORBIDDEN');
        await env.DB.prepare('UPDATE users SET role=?,updated_at=? WHERE id=?').bind(role, now(), targetId).run();
        await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(targetId).run();
        await audit(env, role === 'admin' ? 'user.promoted_admin' : 'user.demoted_admin', targetId, target.email);
        return json({ ok: true, role });
      }
      if (action === 'reset-password' && method === 'POST') {
        const b = await bodyJson(request);
        if (typeof b.password !== 'string' || b.password.length < 10 || b.password.length > 128) return fail(400, '新密码需为 10-128 位', 'INVALID_ARGUMENT');
        await env.DB.prepare('UPDATE users SET password_hash=?,updated_at=? WHERE id=?').bind(await passwordHash(b.password), now(), targetId).run();
        await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(targetId).run();
        await audit(env, 'user.password_reset', targetId, target.email);
        return json({ ok: true, message: '密码已重置，该用户所有登录会话已失效' });
      }
      if (action === 'status' && method === 'POST') {
        const b = await bodyJson(request); const disabled = b.disabled === true;
        if (disabled && targetId === admin.id) return fail(400, '不能停用当前登录的管理员账号', 'SELF_DISABLE_FORBIDDEN');
        await env.DB.prepare('UPDATE users SET disabled=?,updated_at=? WHERE id=?').bind(disabled ? 1 : 0, now(), targetId).run();
        if (disabled) await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(targetId).run();
        await audit(env, disabled ? 'user.disabled' : 'user.enabled', targetId, target.email);
        return json({ ok: true, disabled });
      }
      if (!action && method === 'DELETE') {
        if (targetId === admin.id) return fail(400, '不能删除当前登录的管理员账号', 'SELF_DELETE_FORBIDDEN');
        // All steps share the same guard and D1 batch transaction. Never discard an
        // ambiguous upstream debit or its reserved bonus/stock while it is pending.
        const noPending = "NOT EXISTS (SELECT 1 FROM orders WHERE user_id=? AND status='PENDING')";
        const deleted = await env.DB.batch([
          env.DB.prepare(`DELETE FROM sessions WHERE user_id=? AND ${noPending}`).bind(targetId, targetId),
          env.DB.prepare(`DELETE FROM purchase_intents WHERE user_id=? AND ${noPending}`).bind(targetId, targetId),
          env.DB.prepare(`DELETE FROM consumption_jobs WHERE user_id=? AND ${noPending}`).bind(targetId, targetId),
          env.DB.prepare(`DELETE FROM orders WHERE user_id=? AND ${noPending}`).bind(targetId, targetId),
          env.DB.prepare(`DELETE FROM bonus_wallets WHERE user_id=? AND ${noPending}`).bind(targetId, targetId),
          env.DB.prepare(`DELETE FROM users WHERE id=? AND ${noPending}`).bind(targetId, targetId),
        ]);
        if (!Number(deleted[5]?.meta?.changes || 0)) return fail(409, '该用户有待确认订单，请先同步订单后再删除', 'USER_HAS_PENDING_ORDERS');
        // Ledger rows are retained as an immutable reconciliation trail.
        await audit(env, 'user.deleted', targetId, target.email);
        return json({ ok: true });
      }
      return fail(405, '不支持的操作', 'METHOD_NOT_ALLOWED');
    }
  }

  if (path === '/api/webhook' && method === 'POST') {
    const raw = await request.text(); const event = await verifyWebhook(request, env, raw);
    if (!event) return fail(401, '通知签名或时间戳校验失败', 'INVALID_WEBHOOK_SIGNATURE');
    const type = String(event.type || 'unknown').slice(0, 80); const userId = String(event.user_id || '').slice(0, 128);
    await env.DB.prepare('INSERT OR IGNORE INTO webhook_events(event_id,event_type,user_id,payload_json,received_at) VALUES(?,?,?,?,?)').bind(event.id, type, userId, raw, now()).run();
    return json({ received: true, duplicateSafe: true });
  }
  return null;
}

/* ---------------- 积分充值（一人付购买入口） ---------------- */

async function purchasePointsHandler(request, env) {
  const user = await requireUser(request, env);
  const unavailable = await checkCapability(env, 'purchase_entry');
  if (unavailable) return unavailable;
  const body = await bodyJson(request);
  const key = body.idempotency_key;
  const sku = body.sku_id || '';
  if (!validText(key, 1, 128) || typeof sku !== 'string' || sku.length > 128) return fail(400, '购买编号或套餐编号无效', 'INVALID_ARGUMENT');
  const p = await yirenfuProduct(env);
  const options = Array.isArray(p.charging_options) ? p.charging_options : [];
  if (sku && !options.some(o => o.sku_id === sku)) return fail(409, '套餐不在一人付当前可售列表中，请刷新后重试', 'SKU_NOT_AVAILABLE');
  const existing = await env.DB.prepare('SELECT * FROM purchase_intents WHERE idempotency_key=?').bind(key).first();
  if (existing && (existing.user_id !== user.id || existing.sku_id !== sku)) return fail(409, '购买编号已关联不同用户或套餐', 'IDEMPOTENCY_CONFLICT');
  if (!existing) {
    try { await env.DB.prepare('INSERT INTO purchase_intents(idempotency_key,user_id,sku_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?)').bind(key, user.id, sku, 'CREATED', now(), now()).run(); }
    catch { return fail(409, '购买编号已被使用', 'IDEMPOTENCY_CONFLICT'); }
  }
  const found = await yirenfu(env, '/purchase/query', 'POST', { user_id: user.id, idempotency_key: key }).catch(() => null);
  let result;
  if (found?.response.ok) result = found.data.response || {};
  else {
    const payload = { user_id: user.id, idempotency_key: key };
    if (sku) payload.sku_id = sku;
    const created = await yirenfu(env, '/purchase', 'POST', payload);
    if (!created.response.ok) return json(created.data, created.response.status);
    result = created.data;
  }
  await env.DB.prepare('UPDATE purchase_intents SET status=?,response_json=?,updated_at=? WHERE idempotency_key=?').bind(result.status || 'UNKNOWN', JSON.stringify(result), now(), key).run();
  return json({ ...result, business_id: key });
}

export default {
  async fetch(request, env, ctx) {
    try {
      const response = await route(request, env, ctx);
      if (response) return response;
      if ((request.method === 'GET' || request.method === 'HEAD') && env.ASSETS) {
        const assetUrl = new URL(request.url);
        if (assetUrl.pathname === '/admin') assetUrl.pathname = '/admin.html';
        else if (assetUrl.pathname === '/shop') assetUrl.pathname = '/shop.html';
        else if (assetUrl.pathname === '/account') assetUrl.pathname = '/account.html';
        else if (assetUrl.pathname === '/') assetUrl.pathname = '/index.html';
        const assetResponse = await env.ASSETS.fetch(new Request(assetUrl, request));
        return withStaticCache(assetResponse, request.url);
      }
      return fail(404, 'Not Found', 'NOT_FOUND');
    } catch (e) {
      if (e.message === 'BODY_TOO_LARGE') return fail(413, '请求内容过大', 'BODY_TOO_LARGE');
      if (e instanceof SyntaxError || e.message === 'INVALID_JSON') return fail(400, 'JSON 格式无效', 'INVALID_JSON');
      return fail(e.status || 500, e.status ? e.message : '服务器内部错误', e.code || 'INTERNAL_ERROR');
    }
  }
};

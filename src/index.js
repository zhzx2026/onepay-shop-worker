import { cachedPublicJson, invalidatePublicCache, withStaticCache, productTagFilters } from './cache.js';
import { detectNetdisk, providerTags, normalizePreview, sharePasscode, startShareScan, continueShareScan, scanSummary, SCAN_BATCH_CALLS } from './netdisk.js';
import { bonusBalance, bonusHistory, adjustBonus, reserveOrder, refundOrder } from './bonus.js';
import { SUBSCRIPTION_FREQUENCIES, validSubscriptionDays, isSubscriptionActive, finalizeSubscriptionOrder, subscriptionFor, subscriptionView, parseSubscriptionUpdate, subscriberUpdateView } from './subscriptions.js';
import { pairingSchemaReady, issuePairCode, cancelPairCodes, pairCodeStatus, recordPairAttempt, exchangePairCode, validPairedAgent, listAgentTokens, revokeAgentToken } from './agent.js';

const API = 'https://ai6666.com/opcpay/api/pay/v1';
const encoder = new TextEncoder();
// Session cookies are Secure; a plain-HTTP page would silently drop them and
// make a successful login look like a failed one.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);
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
// SameSite=Lax still blocks cross-site form POSTs, but unlike Strict it keeps
// the session when a user arrives from an external link, a QR code or an
// in-app browser that treats the first navigation as cross-site.
function cookie(name, value, maxAge) { return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`; }
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
// Public pairing accepts only tiny JSON. Bound the stream before buffering it,
// including chunked requests that omit or lie about Content-Length.
async function smallBodyJson(request, max = 1024) {
  const length = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(length) && length > max) throw new Error('BODY_TOO_LARGE');
  const reader = request.body?.getReader(), decoder = new TextDecoder();
  let size = 0, text = '';
  if (reader) {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > max) { try { await reader.cancel(); } catch {} throw new Error('BODY_TOO_LARGE'); }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
  }
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
// Password endpoints are the cheapest resource for an attacker, so failures are
// counted per (scope, IP, account) before any PBKDF2 work happens. A missing
// table must not lock everybody out, so throttling fails open.
const AUTH_WINDOW_SECONDS = 900;
const AUTH_MAX_FAILURES = 8;
function clientIp(request) {
  return String(request.headers.get('CF-Connecting-IP') || (request.headers.get('x-forwarded-for') || '').split(',')[0] || 'unknown').trim().slice(0, 64);
}
async function authAttemptKey(request, scope, identity) {
  return `${scope}:${await sha256(`${clientIp(request)}|${String(identity || '').toLowerCase()}`)}`;
}
async function authBlocked(env, key) {
  try {
    const row = await env.DB.prepare('SELECT count,window_start FROM auth_attempts WHERE key=?').bind(key).first();
    if (!row) return false;
    if (Math.floor(Date.now() / 1000) - Number(row.window_start) > AUTH_WINDOW_SECONDS) return false;
    return Number(row.count) >= AUTH_MAX_FAILURES;
  } catch { return false; }
}
async function recordAuthAttempt(env, key) {
  const seconds = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(`INSERT INTO auth_attempts(key,count,window_start,updated_at) VALUES(?,1,?,?)
      ON CONFLICT(key) DO UPDATE SET
        count=CASE WHEN ?-window_start>? THEN 1 ELSE count+1 END,
        window_start=CASE WHEN ?-window_start>? THEN ? ELSE window_start END,
        updated_at=excluded.updated_at`)
      .bind(key, seconds, now(), seconds, AUTH_WINDOW_SECONDS, seconds, AUTH_WINDOW_SECONDS, seconds).run();
    if (Math.random() < 0.05) {
      await env.DB.prepare('DELETE FROM auth_attempts WHERE window_start < ?').bind(seconds - 86400).run().catch(() => {});
    }
  } catch { /* Never fail a login because the throttle table is unavailable. */ }
}
async function clearAuthFailures(env, key) {
  try { await env.DB.prepare('DELETE FROM auth_attempts WHERE key=?').bind(key).run(); } catch {}
}
function tooManyAttempts() {
  return json({ error: '尝试次数过多，请 15 分钟后再试或联系管理员', error_code: 'AUTH_RATE_LIMITED' }, 429, { 'retry-after': '900' });
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
    product_kind: p.product_kind || 'SINGLE',
    allow_repeat: Boolean(p.allow_repeat),
    subscription_days: Number(p.subscription_days || 0),
    update_frequency: p.update_frequency || 'IRREGULAR',
    delivery_type: p.delivery_type,
    delivery_label: p.product_kind === 'SUBSCRIPTION' ? '系列订阅' : (({ TEXT: '文本内容', LINK: '下载链接', FILE: '文件下载' })[p.delivery_type] || '数字交付'),
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
    product_kind: o.product_kind || 'SINGLE',
    subscription_days: Number(o.subscription_days || 0),
    delivery_type: o.delivery_type,
    created_at: o.created_at,
    delivered_at: o.delivered_at,
  };
}
function orderDelivery(o) {
  if (o.product_kind === 'SUBSCRIPTION') return { type: 'SUBSCRIPTION', product_id: o.product_id, days: Number(o.subscription_days || 0) };
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
async function finalizeOrder(env, order, token) {
  const key = order.idempotency_key;
  if (order.product_kind === 'SUBSCRIPTION') return finalizeSubscriptionOrder(env, key, token);
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
  const productKind = String(b.product_kind ?? 'SINGLE').toUpperCase();
  const days = productKind === 'SUBSCRIPTION' ? Number(b.subscription_days ?? 0) : 0;
  const frequency = productKind === 'SUBSCRIPTION' ? String(b.update_frequency ?? 'IRREGULAR').toUpperCase() : 'IRREGULAR';
  const repeat = b.allow_repeat ?? false;
  const type = productKind === 'SUBSCRIPTION' ? 'TEXT' : String(b.delivery_type ?? 'TEXT').toUpperCase();
  const text = productKind === 'SUBSCRIPTION' ? '' : String(b.delivery_text ?? '');
  const link = String(b.delivery_url ?? '').trim();
  const tags = providerTags(rawTags, type, link, MAX_PRODUCT_TAGS);
  const preview = normalizePreview(productKind === 'SUBSCRIPTION' || type === 'LINK' ? b.preview_files : undefined);
  const source = type === 'LINK' && ['quark', 'baidu'].includes(b.preview_source) && detectNetdisk(link)?.id === b.preview_source ? b.preview_source : 'manual';
  const fileKey = String(b.file_key ?? '').trim();
  const fileName = String(b.file_name ?? '').trim();
  const status = String(b.status ?? 'ACTIVE').toUpperCase();
  const sort = Number(b.sort_order ?? 0);
  let stock = b.stock;
  if (stock === '' || stock === null || stock === undefined) stock = null;
  else stock = Number(stock);

  if (!preview.ok) return preview;
  if (!['SINGLE', 'SUBSCRIPTION'].includes(productKind) || !validSubscriptionDays(days) || !SUBSCRIPTION_FREQUENCIES.has(frequency)) return { ok: false, error: '商品类型、订阅时长或更新频率无效' };
  if (![true, false, 0, 1].includes(repeat)) return { ok: false, error: '重复购买设置无效' };
  if (title.length < 1 || title.length > 80) return { ok: false, error: '商品名称需为 1-80 个字符' };
  if (summary.length > 200) return { ok: false, error: '副标题最多 200 个字符' };
  if (description.length > 4000) return { ok: false, error: '商品详情最多 4000 个字符' };
  if (!Number.isInteger(price) || price < 1 || price > 99999999) return { ok: false, error: '积分价格需为 1-99999999 的整数' };
  if (cover && (cover.length > 500 || !(httpUrl(cover) || cover.startsWith('/')))) return { ok: false, error: '封面地址需为 http(s) 链接或以 / 开头的站内路径' };
  if (categoryId && !/^cat_[A-Za-z0-9\-]{1,60}$/.test(categoryId)) return { ok: false, error: '商品分类编号无效' };
  if (!DELIVERY_TYPES.has(type)) return { ok: false, error: '交付方式只能是 TEXT / LINK / FILE' };
  if (productKind === 'SINGLE' && type === 'TEXT' && (text.trim().length < 1 || text.length > 20000)) return { ok: false, error: '文本交付内容需为 1-20000 个字符' };
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
      product_kind: productKind, allow_repeat: repeat ? 1 : 0, subscription_days: days, update_frequency: frequency,
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
    const done = await finalizeOrder(env, order, token);
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
  const expectedPrice = body.expected_price ?? null, expectedKind = body.expected_kind ?? null, expectedDays = body.expected_days ?? null;
  const expectedSubscriptionRevision = body.subscription_revision ?? null;
  if ((expectedPrice !== null && (!Number.isInteger(expectedPrice) || expectedPrice < 1)) ||
      (expectedKind !== null && !['SINGLE', 'SUBSCRIPTION'].includes(expectedKind)) ||
      (expectedDays !== null && !validSubscriptionDays(expectedDays)) ||
      (expectedSubscriptionRevision !== null && (typeof expectedSubscriptionRevision !== 'string' || !/^(none|permanent|until:\d{1,12})$/.test(expectedSubscriptionRevision)))) return fail(400, '确认的商品条件无效', 'INVALID_ARGUMENT');
  const termsChanged = p => (expectedPrice !== null && Number(p.price_points) !== expectedPrice) ||
    (expectedKind !== null && (p.product_kind || 'SINGLE') !== expectedKind) ||
    (expectedDays !== null && Number(p.subscription_days || 0) !== expectedDays);
  let order = await env.DB.prepare('SELECT * FROM orders WHERE idempotency_key=?').bind(key).first();
  if (!order) {
    const p = await env.DB.prepare('SELECT * FROM products WHERE id=?').bind(productId).first();
    if (!p) return fail(404, '商品不存在', 'PRODUCT_NOT_FOUND');
    if (p.status !== 'ACTIVE') return fail(409, '该商品已下架', 'PRODUCT_UNAVAILABLE');
    if (p.product_kind === 'SUBSCRIPTION' && (expectedPrice === null || expectedKind === null || expectedDays === null || expectedSubscriptionRevision === null)) {
      return fail(409, '请刷新页面并确认订阅价格、期限和当前权益', 'SUBSCRIPTION_CONFIRMATION_REQUIRED');
    }
    if (termsChanged(p)) return fail(409, '商品价格或订阅条件已变更，请刷新后确认', 'PRODUCT_TERMS_CHANGED');
    try {
      if (!await reserveOrder(env, { productId, userId: user.id, key, orderNo: orderNo(), expectedPrice, expectedKind, expectedDays, expectedSubscriptionRevision })) {
        // The same key may have reserved the last item between the first read and this batch.
        order = await env.DB.prepare('SELECT * FROM orders WHERE idempotency_key=?').bind(key).first();
        if (!order) {
          const pending = await env.DB.prepare("SELECT idempotency_key FROM orders WHERE user_id=? AND product_id=? AND status='PENDING' LIMIT 1").bind(user.id, productId).first();
          if (pending) return fail(409, '该商品已有待确认订单，请先在「我的已购」同步，避免重复扣分', 'ORDER_ALREADY_PENDING');
          const current = await env.DB.prepare('SELECT * FROM products WHERE id=?').bind(productId).first();
          if (!current || current.status !== 'ACTIVE') return fail(409, '该商品已下架', 'PRODUCT_UNAVAILABLE');
          if (termsChanged(current)) return fail(409, '商品价格或订阅条件已变更，请刷新后确认', 'PRODUCT_TERMS_CHANGED');
          if (current.product_kind === 'SUBSCRIPTION') {
            const sub = await subscriptionFor(env, user.id, productId);
            if (Number(sub?.permanent) === 1) return fail(409, '已拥有永久订阅，无需重复购买', 'ALREADY_SUBSCRIBED');
            const revision = sub ? `until:${Number(sub.expires_at)}` : 'none';
            if (expectedSubscriptionRevision !== null && expectedSubscriptionRevision !== revision) return fail(409, '订阅状态已变更，请刷新后确认', 'SUBSCRIPTION_CHANGED');
          } else if (!current.allow_repeat) {
            const owned = await env.DB.prepare("SELECT idempotency_key FROM orders WHERE user_id=? AND product_id=? AND status='DELIVERED' LIMIT 1").bind(user.id, productId).first();
            if (owned) return fail(409, '该商品已购买，不能重复兑换', 'ALREADY_PURCHASED');
          }
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

async function listOrders(env, user, limit = 50, offset = 0) {
  const rows = await env.DB.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC,idempotency_key DESC LIMIT ? OFFSET ?').bind(user.id, limit, offset).all();
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

async function listSubscriptions(env, user) {
  const rows = await env.DB.prepare(`SELECT s.*,p.title,p.cover_url,p.status FROM subscriptions s
    LEFT JOIN products p ON p.id=s.product_id WHERE s.user_id=? ORDER BY s.updated_at DESC`).bind(user.id).all();
  return (rows.results || []).map(subscriptionView);
}

async function subscriptionUpdates(request, env, user, productId, updateId = '') {
  const sub = await subscriptionFor(env, user.id, productId);
  if (!sub) return fail(404, '未找到该系列订阅', 'SUBSCRIPTION_NOT_FOUND');
  if (!isSubscriptionActive(sub)) return fail(403, '订阅已到期，请续订后查看系列更新', 'SUBSCRIPTION_EXPIRED');
  if (updateId) {
    const update = await env.DB.prepare("SELECT * FROM subscription_updates WHERE id=? AND product_id=? AND status='PUBLISHED'").bind(updateId, productId).first();
    if (!update || update.delivery_type !== 'FILE' || !update.file_key) return fail(404, '更新文件不存在', 'FILE_NOT_FOUND');
    if (!env.BUCKET) return fail(503, '服务端尚未绑定对象存储', 'STORAGE_NOT_CONFIGURED');
    const object = await env.BUCKET.get(update.file_key);
    if (!object) return fail(404, '文件已不存在，请联系管理员', 'FILE_MISSING');
    return new Response(object.body, { headers: {
      'content-type': object.httpMetadata?.contentType || 'application/octet-stream',
      'content-length': String(object.size),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(update.file_name || 'download')}`,
      'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
    } });
  }
  const url = new URL(request.url);
  const rawOffset = Number(url.searchParams.get('offset') || 0);
  const offset = Number.isSafeInteger(rawOffset) ? Math.max(0, Math.min(100000, rawOffset)) : 0;
  const limit = 30;
  const rows = await env.DB.prepare("SELECT * FROM subscription_updates WHERE product_id=? AND status='PUBLISHED' ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?")
    .bind(productId, limit + 1, offset).all();
  const items = rows.results || [];
  return json({ items: items.slice(0, limit).map(subscriberUpdateView), has_more: items.length > limit, next_offset: offset + limit });
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

// Agent credentials never grant admin or publishing privileges. Keep the old
// Worker Secret as an optional compatibility path; paired tokens expire and
// can be revoked independently. Neither raw credential is stored in D1.
function agentConfigured(env) {
  return /^[^\s]{32,512}$/.test(String(env.AGENT_API_TOKEN || ''));
}
async function requireAgent(request, env) {
  const match = (request.headers.get('authorization') || '').match(/^Bearer ([^\s]{1,512})$/i);
  const candidate = match?.[1] || '';
  if (agentConfigured(env) && constantEq(await sha256(candidate), await sha256(String(env.AGENT_API_TOKEN)))) return;
  if (/^agt_[A-Za-z0-9_-]{43}$/.test(candidate)) {
    let valid;
    try { valid = await validPairedAgent(env, candidate); }
    catch { throw Object.assign(new Error('Agent 配对功能暂不可用，请确认数据库迁移'), { status: 503, code: 'AGENT_PAIRING_UNAVAILABLE' }); }
    if (valid) return;
  }
  throw Object.assign(new Error('Agent 令牌无效或已过期，请重新配对'), { status: 401, code: 'AGENT_UNAUTHORIZED' });
}

function revokeIssuedAgentStatements(env, userId) {
  return [
    env.DB.prepare('DELETE FROM agent_pair_codes WHERE issued_by=? AND used_at IS NULL').bind(userId),
    env.DB.prepare('UPDATE agent_tokens SET revoked_at=? WHERE issued_by=? AND revoked_at IS NULL').bind(Math.floor(Date.now() / 1000), userId),
  ];
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
  // Providers may send a numeric id in the body while the header is always a
  // string, so compare the coerced form instead of the raw values.
  try { const parsed = JSON.parse(raw); return parsed && String(parsed.id) === String(eventId) ? parsed : false; } catch { return false; }
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

  // Pairing is the only unauthenticated Agent operation. The code is sent in
  // the body, rate-limited before validation, single-use and never logged.
  if (path === '/api/agent/pair' && method === 'POST') {
    let allowed;
    try { allowed = await recordPairAttempt(env, request.headers.get('CF-Connecting-IP')); }
    catch { return fail(503, 'Agent 配对暂不可用，请检查数据库迁移', 'AGENT_PAIRING_UNAVAILABLE'); }
    if (!allowed) return json({ error: '配对尝试过于频繁，请稍后重试', error_code: 'PAIR_RATE_LIMITED' }, 429, { 'retry-after': '300' });
    const body = await smallBodyJson(request);
    if (typeof body.code !== 'string' || !/^\d{10}$/.test(body.code)) return fail(400, '配对码应为 10 位数字字符串', 'INVALID_PAIR_CODE');
    let pair;
    try { pair = await exchangePairCode(env, body.code); }
    catch { return fail(503, 'Agent 配对暂不可用，请稍后重试', 'AGENT_PAIRING_UNAVAILABLE'); }
    if (!pair) return fail(401, '配对码无效、已过期或已使用，请管理员重新生成', 'PAIR_CODE_INVALID');
    await audit(env, 'agent.paired', pair.credential_id, '一次性配对成功');
    return json(pair, 201);
  }

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
  // Single product detail. Hidden or deleted products stay invisible to the
  // public even though the URL is guessable only by its random id.
  const productDetail = path.match(/^\/api\/products\/([A-Za-z0-9_-]{1,64})$/);
  if (productDetail && method === 'GET') return cachedPublicJson(request, async () => {
    const row = await env.DB.prepare("SELECT * FROM products WHERE id=? AND status='ACTIVE'").bind(productDetail[1]).first();
    if (!row) return fail(404, '商品不存在或已下架', 'PRODUCT_NOT_FOUND');
    return json({ product: publicProduct({ ...row, tags: parseTags(row.tags), preview_files: storedPreview(row.preview_files) }) });
  }, ctx);
  const buyMatch = path.match(/^\/api\/products\/([A-Za-z0-9_\-]{1,64})\/purchase$/);
  if (buyMatch && method === 'POST') {
    return purchaseProduct(request, env, buyMatch[1]);
  }

  // 我的订单 / 已购内容
  if (path === '/api/orders' && method === 'GET') {
    const user = await requireUser(request, env);
    const rawOffset = Number(url.searchParams.get('offset') || 0);
    const offset = Number.isSafeInteger(rawOffset) ? Math.max(0, Math.min(100000, rawOffset)) : 0;
    const items = await listOrders(env, user, 51, offset);
    return json({ items: items.slice(0, 50), has_more: items.length > 50, next_offset: offset + 50 });
  }
  if (path === '/api/orders/sync' && method === 'POST') {
    const user = await requireUser(request, env);
    const synced = await syncOrders(env, user, request);
    return json({ ok: true, synced, items: await listOrders(env, user) });
  }
  if (path === '/api/library' && method === 'GET') {
    const user = await requireUser(request, env);
    const owned = await env.DB.prepare("SELECT DISTINCT product_id FROM orders WHERE user_id=? AND status='DELIVERED' AND product_kind='SINGLE'").bind(user.id).all();
    return json({ owned_product_ids: (owned.results || []).map(row => row.product_id), subscriptions: await listSubscriptions(env, user) });
  }
  if (path === '/api/subscriptions' && method === 'GET') {
    const user = await requireUser(request, env);
    return json({ items: await listSubscriptions(env, user) });
  }
  const subscriptionRoute = path.match(/^\/api\/subscriptions\/([A-Za-z0-9_\-]{1,64})\/updates(?:\/([A-Za-z0-9_\-]{1,64})\/file)?$/);
  if (subscriptionRoute && method === 'GET') {
    const user = await requireUser(request, env);
    return subscriptionUpdates(request, env, user, subscriptionRoute[1], subscriptionRoute[2] || '');
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
    const registerKey = await authAttemptKey(request, 'register', clientIp(request));
    if (await authBlocked(env, registerKey)) return tooManyAttempts();
    const uid = id('usr_');
    const existing = await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first();
    if (existing) { await recordAuthAttempt(env, registerKey); return fail(409, '该邮箱已注册，请直接登录', 'EMAIL_EXISTS'); }
    try { await env.DB.prepare('INSERT INTO users(id,email,password_hash,created_at,updated_at) VALUES(?,?,?,?,?)').bind(uid, email, await passwordHash(password), now(), now()).run(); }
    catch (e) {
      if (/UNIQUE|constraint/i.test(String(e && e.message))) { await recordAuthAttempt(env, registerKey); return fail(409, '该邮箱已注册，请直接登录', 'EMAIL_EXISTS'); }
      console.error('register_failed', String(e && e.message || e));
      return fail(500, '注册暂时失败，请稍后重试或联系管理员', 'REGISTER_FAILED');
    }
    await recordAuthAttempt(env, registerKey);
    const session = await createSession(env, uid, 'user');
    return json({ ok: true, user: { id: uid, email } }, 201, { 'set-cookie': cookie(env.COOKIE_NAME || 'onepay_session', session.token, session.maxAge) });
  }
  if (path === '/api/auth/login' && method === 'POST') {
    const b = await bodyJson(request); const email = String(b.email || '').trim().toLowerCase();
    const loginKey = await authAttemptKey(request, 'login', email);
    if (await authBlocked(env, loginKey)) return tooManyAttempts();
    const account = await env.DB.prepare('SELECT id,email,password_hash,COALESCE(disabled,0) AS disabled FROM users WHERE email=?').bind(email).first();
    if (!account || !await passwordMatches(String(b.password || ''), account.password_hash)) {
      await recordAuthAttempt(env, loginKey);
      return fail(401, '邮箱或密码不正确', 'LOGIN_FAILED');
    }
    if (account.disabled) return fail(403, '该账号已被停用，请联系管理员', 'ACCOUNT_DISABLED');
    await clearAuthFailures(env, loginKey);
    const session = await createSession(env, account.id, 'user');
    await env.DB.prepare('UPDATE users SET last_login_at=? WHERE id=?').bind(now(), account.id).run().catch(() => {});
    return json({ ok: true, user: { id: account.id, email: account.email } }, 200, { 'set-cookie': cookie(env.COOKIE_NAME || 'onepay_session', session.token, session.maxAge) });
  }
  if (path === '/api/admin/login' && method === 'POST') {
    const b = await bodyJson(request);
    const email = String(b.email || '').trim().toLowerCase();
    const adminKey = await authAttemptKey(request, 'admin-login', email);
    if (await authBlocked(env, adminKey)) return tooManyAttempts();
    const account = await env.DB.prepare('SELECT id,email,password_hash,role,COALESCE(disabled,0) AS disabled FROM users WHERE email=?').bind(email).first();
    if (!account || !await passwordMatches(String(b.password || ''), account.password_hash)) {
      await recordAuthAttempt(env, adminKey);
      return fail(401, '邮箱或密码不正确', 'LOGIN_FAILED');
    }
    if (account.disabled) return fail(403, '该账号已被停用，请联系管理员', 'ACCOUNT_DISABLED');
    if (account.role !== 'admin') { await recordAuthAttempt(env, adminKey); return fail(403, '该账号没有管理员权限', 'NOT_ADMIN'); }
    await clearAuthFailures(env, adminKey);
    const session = await createSession(env, account.id, 'admin');
    await env.DB.prepare('UPDATE users SET last_login_at=? WHERE id=?').bind(now(), account.id).run().catch(() => {});
    await audit(env, 'admin.login', account.id, account.email);
    return json({ ok: true, user: { id: account.id, email: account.email, role: account.role } }, 200, { 'set-cookie': cookie(sessionCookieName(env, 'admin'), session.token, session.maxAge) });
  }
  if (path === '/api/auth/password' && method === 'POST') {
    const user = await requireUser(request, env);
    const b = await bodyJson(request);
    const current = String(b.current_password ?? ''), next = String(b.new_password ?? '');
    if (next.length < 10 || next.length > 128) return fail(400, '新密码需为 10-128 位', 'INVALID_ARGUMENT');
    if (next === current) return fail(400, '新密码不能与当前密码相同', 'INVALID_ARGUMENT');
    const changeKey = await authAttemptKey(request, 'password', user.id);
    if (await authBlocked(env, changeKey)) return tooManyAttempts();
    const account = await env.DB.prepare('SELECT password_hash FROM users WHERE id=?').bind(user.id).first();
    if (!account || !await passwordMatches(current, account.password_hash)) {
      await recordAuthAttempt(env, changeKey);
      return fail(403, '当前密码不正确', 'CURRENT_PASSWORD_INVALID');
    }
    await clearAuthFailures(env, changeKey);
    const keep = await sha256(getCookie(request, sessionCookieName(env, 'user')) || '');
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET password_hash=?,updated_at=? WHERE id=?').bind(await passwordHash(next), now(), user.id),
      // Keep the device that made the change signed in, drop every other one.
      env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').bind(user.id, keep),
    ]);
    await audit(env, 'user.password_changed', user.id, user.email);
    return json({ ok: true, message: '密码已更新，其他设备的登录已退出' });
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
    // One summary row keeps the account page honest regardless of paging:
    // what the user has actually spent and how many orders were delivered.
    const summary = await env.DB.prepare(
      `SELECT COALESCE(SUM(CASE WHEN status='DELIVERED' THEN price_points ELSE 0 END),0) AS spent,
        COALESCE(SUM(CASE WHEN status='DELIVERED' THEN bonus_points_used ELSE 0 END),0) AS bonus_used,
        COALESCE(SUM(CASE WHEN status='DELIVERED' THEN 1 ELSE 0 END),0) AS delivered,
        COALESCE(SUM(CASE WHEN status='PENDING' THEN 1 ELSE 0 END),0) AS pending
       FROM orders WHERE user_id=?`
    ).bind(user.id).first();
    const spent = Number(summary?.spent || 0), bonusUsed = Number(summary?.bonus_used || 0);
    const counters = {
      spent_points: spent,
      onepay_used: Math.max(0, spent - bonusUsed),
      order_count: Number(summary?.delivered || 0),
      pending_orders: Number(summary?.pending || 0),
      bonus_used: bonusUsed,
    };
    try {
      const unavailable = await checkCapability(env, 'entitlement_query');
      if (unavailable) return json({ bonus_points: bonus, ...counters, onepay_points: null, total_points: null, upstream_available: false, upstream_message: '支付宝积分暂不可用' });
      const result = await yirenfu(env, '/access', 'POST', { user_id: user.id });
      if (!result.response.ok) return json({ bonus_points: bonus, ...counters, onepay_points: null, total_points: null, upstream_available: false, upstream_message: '支付宝积分暂不可用' });
      const data = result.data;
      const onepay = data.requires_consumption
        ? (typeof data.remaining === 'number' && Number.isFinite(data.remaining) ? Math.max(0, data.remaining) : null)
        : 0;
      const spendable = onepay === null ? null : (data.access_granted === true ? onepay : 0);
      return json({ ...data, bonus_points: bonus, ...counters, onepay_points: onepay, total_points: spendable === null ? null : bonus + spendable, upstream_available: true });
    } catch {
      return json({ bonus_points: bonus, ...counters, onepay_points: null, total_points: null, upstream_available: false, upstream_message: '支付宝积分暂不可用' });
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
    if (path === '/api/admin/agent/pairing' && method === 'POST') {
      if (!env.BUCKET) return fail(503, '请先绑定 R2，Agent 才能上传文件', 'STORAGE_NOT_CONFIGURED');
      if (!await pairingSchemaReady(env)) return fail(503, '请先应用 0009 Agent 配对数据库迁移', 'AGENT_PAIRING_UNAVAILABLE');
      const body = await smallBodyJson(request);
      const label = typeof body.label === 'string' ? body.label.trim() : '';
      if ((body.label !== undefined && typeof body.label !== 'string') || label.length > 50 || /[\u0000-\u001f\u007f]/.test(label)) return fail(400, 'Agent 备注需为 50 字以内的普通文本', 'INVALID_ARGUMENT');
      const pair = await issuePairCode(env, admin.id, label);
      if (!pair) return fail(401, '管理员状态已变化，请重新登录', 'AUTH_REQUIRED');
      await audit(env, 'agent.pair_code_created', admin.id, '创建一次性配对码');
      return json(pair, 201);
    }
    if (path === '/api/admin/agent/pairing' && method === 'DELETE') {
      if (!await pairingSchemaReady(env)) return fail(503, '请先应用 0009 Agent 配对数据库迁移', 'AGENT_PAIRING_UNAVAILABLE');
      await cancelPairCodes(env, admin.id);
      await audit(env, 'agent.pair_code_canceled', admin.id, '取消尚未使用的配对码');
      return json({ ok: true });
    }
    const agentPairRoute = path.match(/^\/api\/admin\/agent\/pairing\/(pair_[A-Za-z0-9-]{36})$/);
    if (agentPairRoute && method === 'GET') {
      if (!await pairingSchemaReady(env)) return fail(503, '请先应用 0009 Agent 配对数据库迁移', 'AGENT_PAIRING_UNAVAILABLE');
      return json(await pairCodeStatus(env, admin.id, agentPairRoute[1]));
    }
    if (path === '/api/admin/agent/tokens' && method === 'GET') {
      if (!await pairingSchemaReady(env)) return fail(503, '请先应用 0009 Agent 配对数据库迁移', 'AGENT_PAIRING_UNAVAILABLE');
      const rawOffset = Number(url.searchParams.get('offset') || 0);
      const offset = Number.isSafeInteger(rawOffset) ? Math.max(0, Math.min(100000, rawOffset)) : 0;
      return json(await listAgentTokens(env, offset));
    }
    const agentTokenRoute = path.match(/^\/api\/admin\/agent\/tokens\/(agt_[A-Za-z0-9-]{36})$/);
    if (agentTokenRoute && method === 'DELETE') {
      if (!await pairingSchemaReady(env)) return fail(503, '请先应用 0009 Agent 配对数据库迁移', 'AGENT_PAIRING_UNAVAILABLE');
      if (!await revokeAgentToken(env, agentTokenRoute[1])) return fail(404, 'Agent 密钥不存在', 'AGENT_TOKEN_NOT_FOUND');
      await audit(env, 'agent.token_revoked', agentTokenRoute[1], '管理员撤销 Agent 凭据');
      return json({ ok: true });
    }
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
      try { return json({ ok: true, ...await netdiskPreview(env, body, admin) }); }
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
      await env.DB.prepare(`INSERT INTO products(id,title,summary,description,price_points,cover_url,category_id,tags,delivery_type,delivery_text,delivery_url,file_key,file_name,stock,status,sort_order,created_at,updated_at,preview_files,preview_source,preview_updated_at,preview_truncated,product_kind,allow_repeat,subscription_days,update_frequency)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(pid, v.title, v.summary, v.description, v.price_points, v.cover_url, v.category_id, JSON.stringify(v.tags), v.delivery_type, v.delivery_text, v.delivery_url, v.file_key, v.file_name, v.stock, v.status, v.sort_order, now(), now(), JSON.stringify(v.preview_files), v.preview_source, v.preview_files.length ? now() : null, v.preview_truncated, v.product_kind, v.allow_repeat, v.subscription_days, v.update_frequency).run();
      await audit(env, 'goods.created', pid, `${v.title} / ${v.price_points} 积分`);
      await invalidatePublicCache(request, ['catalog']);
      const row = await env.DB.prepare('SELECT * FROM products WHERE id=?').bind(pid).first();
      return json({ ok: true, product: row }, 201);
    }
    const updatesRoute = path.match(/^\/api\/admin\/products\/([A-Za-z0-9_\-]{1,64})\/updates(?:\/([A-Za-z0-9_\-]{1,64}))?$/);
    if (updatesRoute) {
      const productId = updatesRoute[1], updateId = updatesRoute[2] || '';
      const product = await env.DB.prepare('SELECT id,title,product_kind FROM products WHERE id=?').bind(productId).first();
      if (!product) return fail(404, '商品不存在', 'PRODUCT_NOT_FOUND');
      if (product.product_kind !== 'SUBSCRIPTION') return fail(409, '只有订阅系列可以发布更新', 'NOT_SUBSCRIPTION');
      if (method === 'GET' && !updateId) {
        const rawOffset = Number(url.searchParams.get('offset') || 0);
        const offset = Number.isSafeInteger(rawOffset) ? Math.max(0, Math.min(100000, rawOffset)) : 0;
        const rows = await env.DB.prepare('SELECT * FROM subscription_updates WHERE product_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').bind(productId, 51, offset).all();
        const items = rows.results || [];
        return json({ items: items.slice(0, 50), has_more: items.length > 50, next_offset: offset + 50 });
      }
      if ((method === 'POST' && !updateId) || (method === 'PUT' && updateId)) {
        const parsed = parseSubscriptionUpdate(await bodyJson(request));
        if (!parsed.ok) return fail(400, parsed.error, 'INVALID_ARGUMENT');
        const v = parsed.value;
        if (v.delivery_type === 'FILE') {
          if (!env.BUCKET) return fail(503, '尚未绑定 R2 存储', 'STORAGE_NOT_CONFIGURED');
          if (!await env.BUCKET.head(v.file_key)) return fail(404, '更新文件不存在，请重新上传', 'FILE_NOT_FOUND');
        }
        let savedId = updateId;
        if (!updateId) {
          savedId = id('upd_'); const at = now();
          const inserted = await env.DB.prepare(`INSERT INTO subscription_updates(id,product_id,title,summary,delivery_type,delivery_text,delivery_url,file_key,file_name,status,created_at,updated_at)
            SELECT ?,id,?,?,?,?,?,?,?,?,?,? FROM products WHERE id=? AND product_kind='SUBSCRIPTION'`)
            .bind(savedId, v.title, v.summary, v.delivery_type, v.delivery_text, v.delivery_url, v.file_key, v.file_name, v.status, at, at, productId).run();
          if (!Number(inserted.meta?.changes || 0)) return fail(409, '订阅系列已变更', 'NOT_SUBSCRIPTION');
        } else {
          const updated = await env.DB.prepare('UPDATE subscription_updates SET title=?,summary=?,delivery_type=?,delivery_text=?,delivery_url=?,file_key=?,file_name=?,status=?,updated_at=? WHERE id=? AND product_id=?')
            .bind(v.title, v.summary, v.delivery_type, v.delivery_text, v.delivery_url, v.file_key, v.file_name, v.status, now(), updateId, productId).run();
          if (!Number(updated.meta?.changes || 0)) return fail(404, '系列更新不存在', 'UPDATE_NOT_FOUND');
        }
        await audit(env, updateId ? 'series.update_edited' : 'series.update_created', savedId, v.title);
        const row = await env.DB.prepare('SELECT * FROM subscription_updates WHERE id=? AND product_id=?').bind(savedId, productId).first();
        return json({ ok: true, update: row }, updateId ? 200 : 201);
      }
      if (method === 'DELETE' && updateId) {
        const deleted = await env.DB.prepare('DELETE FROM subscription_updates WHERE id=? AND product_id=?').bind(updateId, productId).run();
        if (!Number(deleted.meta?.changes || 0)) return fail(404, '系列更新不存在', 'UPDATE_NOT_FOUND');
        await audit(env, 'series.update_deleted', updateId, product.title);
        return json({ ok: true });
      }
      return fail(405, '不支持的操作', 'METHOD_NOT_ALLOWED');
    }
    const prodRoute = path.match(/^\/api\/admin\/products\/([A-Za-z0-9_\-]{1,64})$/);
    if (prodRoute) {
      const pid = prodRoute[1];
      const existing = await env.DB.prepare('SELECT * FROM products WHERE id=?').bind(pid).first();
      if (!existing) return fail(404, '商品不存在', 'PRODUCT_NOT_FOUND');
      if (method === 'PUT') {
        const body = await bodyJson(request);
        // Older clients may omit the new product settings; editing must not reset them.
        for (const field of ['product_kind', 'allow_repeat', 'subscription_days', 'update_frequency']) {
          if (!Object.hasOwn(body, field)) body[field] = existing[field];
        }
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
        const updated = await env.DB.prepare(`UPDATE products SET title=?,summary=?,description=?,price_points=?,cover_url=?,category_id=?,tags=?,delivery_type=?,delivery_text=?,delivery_url=?,file_key=?,file_name=?,stock=?,status=?,sort_order=?,updated_at=?,preview_files=?,preview_source=?,preview_updated_at=?,preview_truncated=?,product_kind=?,allow_repeat=?,subscription_days=?,update_frequency=?
          WHERE id=? AND (product_kind=? OR (NOT EXISTS (SELECT 1 FROM orders WHERE product_id=products.id AND status IN ('PENDING','DELIVERED'))
            AND NOT EXISTS (SELECT 1 FROM subscription_updates WHERE product_id=products.id)))`)
          .bind(v.title, v.summary, v.description, v.price_points, v.cover_url, v.category_id, JSON.stringify(v.tags), v.delivery_type, v.delivery_text, v.delivery_url, v.file_key, v.file_name, v.stock, v.status, v.sort_order, now(), JSON.stringify(v.preview_files), v.preview_source, previewTime, v.preview_truncated, v.product_kind, v.allow_repeat, v.subscription_days, v.update_frequency, pid, v.product_kind).run();
        if (!Number(updated.meta?.changes || 0)) return fail(409, '已有订单或系列更新的商品不能更改类型', 'PRODUCT_KIND_LOCKED');
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
        // Updates are private to this product; no pending or completed orders exist here.
        await env.DB.prepare('DELETE FROM subscription_updates WHERE product_id=?').bind(pid).run();
        await audit(env, 'goods.deleted', pid, existing.title);
        await invalidatePublicCache(request, ['catalog']);
        return json({ ok: true, deleted: true });
      }
    }
    if (path === '/api/admin/upload' && method === 'POST') return uploadFile(request, env);
    if (path === '/api/admin/storage' && method === 'GET') return json({ configured: Boolean(env.BUCKET), maxSize: MAX_UPLOAD_BYTES });
    if (path === '/api/admin/orders' && method === 'GET') {
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || 50) || 50));
      const rawOffset = Number(url.searchParams.get('offset') || 0);
      const offset = Number.isSafeInteger(rawOffset) ? Math.max(0, Math.min(100000, rawOffset)) : 0;
      const status = String(url.searchParams.get('status') || '').toUpperCase();
      const q = String(url.searchParams.get('q') || '').trim().slice(0, 64);
      const where = [], args = [];
      if (['DELIVERED', 'PENDING', 'FAILED'].includes(status)) { where.push('o.status=?'); args.push(status); }
      if (q) {
        const like = `%${q.replace(/[\\%_]/g, m => `\\${m}`)}%`;
        where.push("(o.order_no LIKE ? ESCAPE '\\' OR o.title LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR o.idempotency_key LIKE ? ESCAPE '\\')");
        args.push(like, like, like, like);
      }
      const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const totalRow = await env.DB.prepare(
        `SELECT COUNT(*) AS c, COALESCE(SUM(CASE WHEN o.status='PENDING' THEN 1 ELSE 0 END),0) AS pending FROM orders o LEFT JOIN users u ON u.id=o.user_id ${filter}`
      ).bind(...args).first();
      const rows = await env.DB.prepare(
        `SELECT o.*, u.email AS user_email FROM orders o LEFT JOIN users u ON u.id=o.user_id ${filter} ORDER BY o.created_at DESC, o.idempotency_key DESC LIMIT ? OFFSET ?`
      ).bind(...args, limit, offset).all();
      const items = (rows.results || []).map(o => ({ ...orderView(o), user_id: o.user_id, email: o.user_email || '' }));
      return json({ items, total: Number(totalRow?.c || 0), pending_total: Number(totalRow?.pending || 0), limit, offset, has_more: offset + items.length < Number(totalRow?.c || 0) });
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
      return json({ apiKeyConfigured: state.apiKeySource !== 'none', webhookSecretConfigured: state.webhookSecretSource !== 'none', databaseConfigured: Boolean(env.DB), agentConfigured: agentConfigured(env), agentPairingReady: await pairingSchemaReady(env), ...state });
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
        await env.DB.batch([
          env.DB.prepare('UPDATE users SET role=?,updated_at=? WHERE id=?').bind(role, now(), targetId),
          env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(targetId),
          ...(role === 'admin' ? [] : revokeIssuedAgentStatements(env, targetId)),
        ]);
        await audit(env, role === 'admin' ? 'user.promoted_admin' : 'user.demoted_admin', targetId, target.email);
        return json({ ok: true, role });
      }
      if (action === 'reset-password' && method === 'POST') {
        const b = await bodyJson(request);
        if (typeof b.password !== 'string' || b.password.length < 10 || b.password.length > 128) return fail(400, '新密码需为 10-128 位', 'INVALID_ARGUMENT');
        await env.DB.batch([
          env.DB.prepare('UPDATE users SET password_hash=?,updated_at=? WHERE id=?').bind(await passwordHash(b.password), now(), targetId),
          env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(targetId),
          ...revokeIssuedAgentStatements(env, targetId),
        ]);
        await audit(env, 'user.password_reset', targetId, target.email);
        return json({ ok: true, message: '密码已重置，该用户登录会话和签发的 Agent 凭据已失效' });
      }
      if (action === 'status' && method === 'POST') {
        const b = await bodyJson(request); const disabled = b.disabled === true;
        if (disabled && targetId === admin.id) return fail(400, '不能停用当前登录的管理员账号', 'SELF_DISABLE_FORBIDDEN');
        await env.DB.batch([
          env.DB.prepare('UPDATE users SET disabled=?,updated_at=? WHERE id=?').bind(disabled ? 1 : 0, now(), targetId),
          ...(disabled ? [env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(targetId), ...revokeIssuedAgentStatements(env, targetId)] : []),
        ]);
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
          env.DB.prepare(`DELETE FROM subscriptions WHERE user_id=? AND ${noPending}`).bind(targetId, targetId),
          env.DB.prepare(`DELETE FROM orders WHERE user_id=? AND ${noPending}`).bind(targetId, targetId),
          env.DB.prepare(`DELETE FROM bonus_wallets WHERE user_id=? AND ${noPending}`).bind(targetId, targetId),
          env.DB.prepare(`DELETE FROM agent_pair_codes WHERE issued_by=? AND ${noPending}`).bind(targetId, targetId),
          env.DB.prepare(`DELETE FROM agent_tokens WHERE issued_by=? AND ${noPending}`).bind(targetId, targetId),
          env.DB.prepare(`DELETE FROM users WHERE id=? AND ${noPending}`).bind(targetId, targetId),
        ]);
        if (!Number(deleted[8]?.meta?.changes || 0)) return fail(409, '该用户有待确认订单，请先同步订单后再删除', 'USER_HAS_PENDING_ORDERS');
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

// Batched, resumable public-share scan. The browser only holds an opaque scan
// id; the share token/cookie stays in D1 and is dropped as soon as the scan
// finishes or goes stale.
async function netdiskPreview(env, body, admin) {
  const target = detectNetdisk(body.url);
  if (!target) throw new Error('仅支持夸克或百度网盘的 HTTPS 分享链接，请手动填写其他目录。');
  const passcode = sharePasscode(body.url, body.passcode);
  const requested = typeof body.scan_id === 'string' && /^nds_[A-Za-z0-9_-]{6,80}$/.test(body.scan_id) ? body.scan_id : '';
  let scanKey = '', state = null;
  if (requested) {
    const row = await env.DB.prepare('SELECT state FROM netdisk_scans WHERE id=? AND owner=?').bind(requested, admin.id).first();
    if (row?.state) {
      try {
        const saved = JSON.parse(row.state);
        // A scan is only resumable for the same share the admin is looking at.
        if (saved?.provider === target.id && saved?.shareId === target.shareId) { state = saved; scanKey = requested; }
      } catch { state = null; }
    }
  }
  if (!state) {
    state = await startShareScan(body.url, passcode);
    scanKey = id('nds_');
    // Expired scans are never resumed; drop them so the table stays small.
    await env.DB.prepare('DELETE FROM netdisk_scans WHERE updated_at < ?')
      .bind(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()).run().catch(() => {});
  }
  state = await continueShareScan(state, passcode, fetch, SCAN_BATCH_CALLS);
  const summary = scanSummary(state);
  if (state.done) {
    await env.DB.prepare('DELETE FROM netdisk_scans WHERE id=?').bind(scanKey).run().catch(() => {});
    return { ...summary, scan_id: '' };
  }
  const at = now();
  await env.DB.prepare('INSERT INTO netdisk_scans(id,owner,state,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at')
    .bind(scanKey, admin.id, JSON.stringify(state), at, at).run();
  return { ...summary, scan_id: scanKey };
}

export default {
  async fetch(request, env, ctx) {
    const requestUrl = new URL(request.url);
    // Secure session cookies are rejected over plain HTTP, so a login would
    // appear to succeed and then bounce straight back to the form. Land every
    // public request on HTTPS first; 308 keeps POST bodies intact.
    if (requestUrl.protocol === 'http:' && !LOCAL_HOSTS.has(requestUrl.hostname)) {
      requestUrl.protocol = 'https:';
      return Response.redirect(requestUrl.toString(), request.method === 'GET' || request.method === 'HEAD' ? 301 : 308);
    }
    try {
      const response = await route(request, env, ctx);
      if (response) return response;
      if ((request.method === 'GET' || request.method === 'HEAD') && env.ASSETS) {
        const assetUrl = new URL(request.url);
        const pages = { '/admin': '/admin.html', '/shop': '/shop.html', '/account': '/account.html', '/product': '/product.html', '/': '/index.html' };
        if (pages[assetUrl.pathname]) assetUrl.pathname = pages[assetUrl.pathname];
        const assetResponse = await env.ASSETS.fetch(new Request(assetUrl, request));
        // A wrong URL used to dump raw JSON at the visitor; show them the shop.
        if (assetResponse.status === 404 && !assetUrl.pathname.startsWith('/api/') && !/\.[a-z0-9]+$/i.test(assetUrl.pathname)) {
          const notFoundUrl = new URL(request.url);
          notFoundUrl.pathname = '/404.html';
          const page = await env.ASSETS.fetch(new Request(notFoundUrl, request));
          if (page.ok) return new Response(page.body, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60', 'x-content-type-options': 'nosniff' } });
        }
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

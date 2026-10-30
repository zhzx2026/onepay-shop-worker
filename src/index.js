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
const PUBLIC_CACHE_PATHS = ['/api/products', '/api/categories', '/api/config'];
async function cachedPublicJson(request, env, produce, ttl = 30) {
  if (request.method !== 'GET' || typeof caches === 'undefined' || !caches.default) return produce();
  const cache = caches.default;
  const key = new Request(new URL(request.url).toString(), { method: 'GET' });
  try {
    const hit = await cache.match(key);
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set('x-cache', 'HIT');
      return new Response(hit.body, { status: hit.status, headers });
    }
  } catch {}
  const response = await produce();
  if (!response.ok) return response;
  const headers = new Headers(response.headers);
  headers.set('cache-control', `public, max-age=0, s-maxage=${ttl}, stale-while-revalidate=${ttl * 5}`);
  headers.set('x-cache', 'MISS');
  const cached = new Response(response.body, { status: response.status, headers });
  try { await cache.put(key, cached.clone()); } catch {}
  return cached;
}
async function invalidatePublicCache(request) {
  if (typeof caches === 'undefined' || !caches.default) return;
  const origin = new URL(request.url).origin;
  await Promise.all(PUBLIC_CACHE_PATHS.map(path => caches.default.delete(new Request(origin + path, { method: 'GET' }))));
}
function withStaticCache(response, pathname) {
  if (!response.ok || response.headers.has('set-cookie')) return response;
  const headers = new Headers(response.headers);
  const isHtml = pathname.endsWith('.html') || pathname === '/';
  headers.set('cache-control', isHtml
    ? 'public, max-age=0, s-maxage=300, stale-while-revalidate=900'
    : 'public, max-age=60, s-maxage=300, stale-while-revalidate=900');
  headers.set('x-cache', 'ASSET');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
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
async function listUsers(env, url) {
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
       (SELECT COUNT(*) FROM orders o WHERE o.user_id=u.id AND o.status='DELIVERED') AS orders
     FROM users u ${filter} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`
  ).bind(Math.floor(Date.now() / 1000), ...args, limit, offset).all();
  return { total: totalRow?.c || 0, limit, offset, items: rows.results || [] };
}
async function yirenfu(env, path, method = 'GET', payload) {
  const key = await apiKeyValue(env);
  if (!key) throw Object.assign(new Error('服务端尚未配置一人付 API Key'), { status: 503, code: 'YIRENFU_KEY_MISSING' });
  const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
  if (payload !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${API}${path}`, { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload) });
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

async function saveLedger(env, key, result) {
  try {
    await env.DB.prepare('UPDATE consumption_jobs SET status=?,response_json=?,updated_at=? WHERE idempotency_key=?')
      .bind(result.status || 'UNKNOWN', JSON.stringify(result), now(), key).run();
  } catch {}
}
async function consumePoints(env, user, key, amount, reason) {
  const capResp = await checkCapability(env, 'entitlement_query');
  // definitive=true 表示尚未发生任何扣减，可以安全回滚库存。
  if (capResp) return { state: 'ERROR', definitive: true, response: capResp };

  const ledger = await env.DB.prepare('SELECT * FROM consumption_jobs WHERE idempotency_key=?').bind(key).first();
  if (ledger) {
    if (ledger.user_id !== user.id || ledger.amount !== amount || ledger.reason !== reason) {
      return { state: 'FAILED', response: fail(409, '同一业务编号必须保持原用户、数量和说明', 'IDEMPOTENCY_CONFLICT') };
    }
    let saved = null;
    try { saved = JSON.parse(ledger.response_json || '{}'); } catch {}
    if (saved && saved.status === 'SUCCEEDED' && saved.confirmed === true) return { state: 'DONE', result: saved };
    if (saved && ['FAILED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(saved.status)) {
      return { state: 'FAILED', response: json({ consumption: saved, business_id: key }, 409) };
    }
  } else {
    try {
      await env.DB.prepare('INSERT INTO consumption_jobs(idempotency_key,user_id,amount,reason,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .bind(key, user.id, amount, reason, 'CREATED', now(), now()).run();
    } catch {
      return { state: 'FAILED', response: fail(409, '业务编号已被使用，请刷新后重试', 'IDEMPOTENCY_CONFLICT') };
    }
  }

  let access;
  try { access = await yirenfu(env, '/access', 'POST', { user_id: user.id }); }
  catch (e) { return { state: 'ERROR', definitive: true, response: fail(e.status || 503, e.message || '查询积分失败', e.code || 'UPSTREAM_ERROR') }; }
  if (!access.response.ok) {
    return { state: 'ERROR', definitive: true, response: json({ error: access.data.error || '积分查询失败', error_code: access.data.error_code || 'ACCESS_FAILED' }, access.response.status) };
  }
  const a = access.data;
  if (!a.requires_consumption) {
    // 一人付当前不是积分/次数模式（例如买断或时长包），无法按积分兑换商品。
    return {
      state: 'FAILED',
      response: json({
        error: '一人付当前收费方式不是积分/次数模式，无法按积分兑换。请在控制台把收费方式改为积分（QUOTA）后重试。',
        error_code: 'BILLING_MODE_NOT_QUOTA',
        billing_mode: a.billing_mode || null,
      }, 409),
    };
  }
  if (a.access_granted !== true || (typeof a.remaining === 'number' && a.remaining < amount)) {
    return {
      state: 'FAILED',
      response: json({
        error: `积分不足：需要 ${amount}，当前剩余 ${a.remaining ?? 0}。请先充值积分。`,
        error_code: 'POINTS_INSUFFICIENT',
        required: amount,
        remaining: a.remaining ?? 0,
        access: a,
      }, 402),
    };
  }
  const cap2 = await checkCapability(env, 'consumption');
  if (cap2) return { state: 'ERROR', definitive: true, response: cap2 };

  let prior = await yirenfu(env, '/consumption', 'POST', { user_id: user.id, idempotency_key: key }).catch(() => null);
  let result = prior?.response.ok ? prior.data : null;
  if (result && !(result.status === 'SUCCEEDED' && result.confirmed === true) && result.status !== 'UNKNOWN' && result.status !== 'PROCESSING') {
    await saveLedger(env, key, result);
    return { state: 'FAILED', response: json({ consumption: result, business_id: key, error: '积分扣减未成功', error_code: 'CONSUME_FAILED' }, 409) };
  }
  if (!result || result.status === 'UNKNOWN' || result.status === 'PROCESSING') {
    let used;
    try { used = await yirenfu(env, '/consume', 'POST', { user_id: user.id, idempotency_key: key, amount, reason }); }
    catch (e) {
      // 请求可能已送达上游，结果未知：不能回滚库存，也不能交付。
      return { state: 'ERROR', definitive: false, response: fail(e.status || 503, e.message || '积分扣减请求未完成，结果未知', e.code || 'CONSUME_UNKNOWN') };
    }
    if (!used.response.ok) {
      const definitive = used.response.status >= 400 && used.response.status < 500;
      return {
        state: definitive ? 'FAILED' : 'ERROR',
        definitive,
        response: json({ error: used.data.error || '积分扣减暂未完成', error_code: used.data.error_code || 'CONSUME_FAILED', business_id: key }, used.response.status),
      };
    }
    result = used.data;
  }
  await saveLedger(env, key, result);
  if (result.status === 'SUCCEEDED' && result.confirmed === true) return { state: 'DONE', result, access: a };
  return {
    state: 'PENDING',
    response: json({ consumption: result, business_id: key, delivered: false, message: '积分扣减结果未确认，稍后会自动同步；同一订单不会重复扣减。' }, 202),
  };
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

function publicProduct(p) {
  return {
    id: p.id,
    title: p.title,
    summary: p.summary,
    description: p.description,
    price_points: p.price_points,
    cover_url: p.cover_url,
    category_id: p.category_id || '',
    tags: parseTags(p.tags),
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
async function reserveStock(env, productId) {
  const r = await env.DB.prepare("UPDATE products SET stock=stock-1, sold_count=sold_count+1, updated_at=? WHERE id=? AND status='ACTIVE' AND (stock IS NULL OR stock>0)")
    .bind(now(), productId).run();
  return Number(r.meta?.changes || 0) > 0;
}
async function releaseStock(env, productId) {
  try {
    await env.DB.prepare(`UPDATE products SET
        stock = CASE WHEN stock IS NULL THEN NULL ELSE stock + 1 END,
        sold_count = CASE WHEN sold_count > 0 THEN sold_count - 1 ELSE 0 END,
        updated_at = ?
      WHERE id = ?`).bind(now(), productId).run();
  } catch {}
}
async function markOrder(env, key, status) {
  try { await env.DB.prepare('UPDATE orders SET status=? WHERE idempotency_key=? AND status<>\'DELIVERED\'').bind(status, key).run(); } catch {}
}
async function finalizeOrder(env, key) {
  await env.DB.prepare("UPDATE orders SET status='DELIVERED', delivered_at=? WHERE idempotency_key=? AND status<>'DELIVERED'").bind(now(), key).run();
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
  const tags = parseTags(b.tags);
  const type = String(b.delivery_type ?? 'TEXT').toUpperCase();
  const text = String(b.delivery_text ?? '');
  const link = String(b.delivery_url ?? '').trim();
  const fileKey = String(b.file_key ?? '').trim();
  const fileName = String(b.file_name ?? '').trim();
  const status = String(b.status ?? 'ACTIVE').toUpperCase();
  const sort = Number(b.sort_order ?? 0);
  let stock = b.stock;
  if (stock === '' || stock === null || stock === undefined) stock = null;
  else stock = Number(stock);

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
      delivery_type: type,
      delivery_text: type === 'TEXT' ? text : '',
      delivery_url: type === 'LINK' ? link : '',
      file_key: type === 'FILE' ? fileKey : '',
      file_name: type === 'FILE' ? (fileName || fileKey.split('/').pop() || '下载文件').slice(0, 120) : '',
      stock, status, sort_order: sort,
    },
  };
}

async function listProducts(env, all = false, q = '', categoryId = '', tag = '') {
  q = String(q || '').trim().slice(0, 64);
  categoryId = String(categoryId || '').trim().slice(0, 64);
  tag = String(tag || '').trim().slice(0, 24);
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
  let items = (rows.results || []).map(p => ({ ...p, tags: parseTags(p.tags) }));
  if (tag) items = items.filter(p => p.tags.includes(tag));
  return { items: all ? items : items.map(publicProduct) };
}

async function purchaseProduct(request, env, productId) {
  const user = await requireUser(request, env);
  const body = await bodyJson(request);
  const key = body.idempotency_key;
  if (!validText(key, 1, 128)) return fail(400, '购买编号无效', 'INVALID_ARGUMENT');

  const p = await env.DB.prepare('SELECT * FROM products WHERE id=?').bind(productId).first();
  if (!p) return fail(404, '商品不存在', 'PRODUCT_NOT_FOUND');
  if (p.status !== 'ACTIVE') return fail(409, '该商品已下架', 'PRODUCT_UNAVAILABLE');
  // 先确认支付凭证可用，避免占用了库存才发现无法扣减积分。
  if (!await apiKeyValue(env)) return fail(503, '服务端尚未配置一人付 API Key，暂时无法兑换', 'YIRENFU_KEY_MISSING');

  let order = await env.DB.prepare('SELECT * FROM orders WHERE idempotency_key=?').bind(key).first();
  if (order) {
    if (order.user_id !== user.id || order.product_id !== p.id) return fail(409, '购买编号已关联其他订单', 'IDEMPOTENCY_CONFLICT');
    if (order.status === 'DELIVERED') return json({ order: orderView(order), delivery: orderDelivery(order), already_delivered: true });
    if (order.status === 'FAILED') return fail(409, '该订单已失败，请重新发起兑换', 'ORDER_FAILED');
  } else {
    const reserved = await reserveStock(env, p.id);
    if (!reserved) return fail(409, '该商品已售罄', 'OUT_OF_STOCK');
    try {
      await env.DB.prepare(`INSERT INTO orders(idempotency_key,order_no,user_id,product_id,title,price_points,delivery_type,delivery_text,delivery_url,file_key,file_name,status,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(key, orderNo(), user.id, p.id, p.title, p.price_points, p.delivery_type, p.delivery_text, p.delivery_url, p.file_key, p.file_name, 'PENDING', now()).run();
    } catch {
      // 并发下可能已由同一次请求的另一次调用插入订单；此时库存已被对方占用，不能重复释放。
      const again = await env.DB.prepare('SELECT * FROM orders WHERE idempotency_key=?').bind(key).first();
      if (!again) {
        await releaseStock(env, p.id);
        return fail(409, '创建订单失败，请重试', 'ORDER_CREATE_FAILED');
      }
      if (again.user_id !== user.id || again.product_id !== p.id) {
        return fail(409, '购买编号已被使用', 'IDEMPOTENCY_CONFLICT');
      }
      order = again;
    }
    if (!order) order = await env.DB.prepare('SELECT * FROM orders WHERE idempotency_key=?').bind(key).first();
  }

  let consumed;
  try { consumed = await consumePoints(env, user, key, p.price_points, `兑换 ${p.title}`); }
  catch { return fail(503, '积分扣减状态未知，订单保持待确认，可在「我的已购」稍后同步', 'CONSUME_UNKNOWN'); }

  // 明确失败或明确未发生扣减 → 回滚库存并结束订单。
  if (consumed.state === 'FAILED' || (consumed.state === 'ERROR' && consumed.definitive)) {
    await releaseStock(env, p.id);
    await markOrder(env, key, 'FAILED');
    return consumed.response;
  }
  // 结果未知 → 保留库存占用与 PENDING 订单，等待同步，绝不交付。
  if (consumed.state === 'ERROR') return consumed.response;
  if (consumed.state === 'PENDING') return consumed.response;

  const done = await finalizeOrder(env, key);
  return json({ order: orderView(done), delivery: orderDelivery(done), delivered: true, remaining: consumed.result?.remaining ?? consumed.access?.remaining ?? null });
}

async function listOrders(env, user, limit = 50) {
  const rows = await env.DB.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT ?').bind(user.id, limit).all();
  return (rows.results || []).map(o => ({
    ...orderView(o),
    delivery: o.status === 'DELIVERED' ? orderDelivery(o) : null,
  }));
}

async function syncOrders(env, user) {
  const rows = await env.DB.prepare("SELECT * FROM orders WHERE user_id=? AND status='PENDING' ORDER BY created_at DESC LIMIT 5").bind(user.id).all();
  let synced = 0;
  for (const o of rows.results || []) {
    const r = await yirenfu(env, '/consumption', 'POST', { user_id: user.id, idempotency_key: o.idempotency_key }).catch(() => null);
    if (!r?.response.ok) continue;
    const d = r.data;
    if (d.status === 'SUCCEEDED' && d.confirmed === true) {
      await saveLedger(env, o.idempotency_key, d);
      await finalizeOrder(env, o.idempotency_key);
      synced++;
    } else if (['FAILED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(d.status)) {
      await saveLedger(env, o.idempotency_key, d);
      await releaseStock(env, o.product_id);
      await markOrder(env, o.idempotency_key, 'FAILED');
      synced++;
    }
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

async function uploadFile(request, env) {
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
  const key = `goods/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${safeName}`;
  await env.BUCKET.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
    customMetadata: { originalName: encodeURIComponent(safeName) },
  });
  await audit(env, 'goods.file_uploaded', key, `${file.size} bytes`);
  return json({ ok: true, key, name: safeName, size: file.size, type: file.type || '' });
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

async function route(request, env) {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  if (method !== 'GET' && !originOk(request)) return fail(403, '请求来源校验失败', 'ORIGIN_REJECTED');
  if (path === '/api/health' && method === 'GET') {
    let apiKeyConfigured = Boolean(env.YIRENFU_API_KEY), webhookSecretConfigured = Boolean(env.YIRENFU_WEBHOOK_SECRET);
    try { apiKeyConfigured = Boolean(await apiKeyValue(env)); webhookSecretConfigured = Boolean(await webhookSecretValue(env)); } catch {}
    return json({ ok: true, apiKeyConfigured, webhookSecretConfigured, storageConfigured: Boolean(env.BUCKET) });
  }
  if (path === '/api/config' && method === 'GET') return cachedPublicJson(request, env, async () => json(await config(env)), 300);
  if (path === '/api/product' && method === 'GET') return cachedPublicJson(request, env, async () => relayUpstream(env, '/product'), 60);
  if (path === '/api/categories' && method === 'GET') return cachedPublicJson(request, env, async () => json(await publicCategories(env)), 60);

  // 商品货架（公开）
  if (path === '/api/products' && method === 'GET') return cachedPublicJson(request, env, async () => json(await listProducts(
    env, false, url.searchParams.get('q'), url.searchParams.get('category'), url.searchParams.get('tag')
  )), 30);
  const buyMatch = path.match(/^\/api\/products\/([A-Za-z0-9_\-]{1,64})\/purchase$/);
  if (buyMatch && method === 'POST') {
    const response = await purchaseProduct(request, env, buyMatch[1]);
    if (response.status === 200 || response.status === 202) await invalidatePublicCache(request);
    return response;
  }

  // 我的订单 / 已购内容
  if (path === '/api/orders' && method === 'GET') {
    const user = await requireUser(request, env);
    return json({ items: await listOrders(env, user) });
  }
  if (path === '/api/orders/sync' && method === 'POST') {
    const user = await requireUser(request, env);
    const synced = await syncOrders(env, user);
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
    const unavailable = await checkCapability(env, 'entitlement_query');
    if (unavailable) return unavailable;
    return relayUpstream(env, '/access', 'POST', { user_id: user.id });
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
      await invalidatePublicCache(request);
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
      await invalidatePublicCache(request);
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
        await invalidatePublicCache(request);
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
        await invalidatePublicCache(request);
        return json({ ok: true, deleted: true });
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
      await env.DB.prepare(`INSERT INTO products(id,title,summary,description,price_points,cover_url,category_id,tags,delivery_type,delivery_text,delivery_url,file_key,file_name,stock,status,sort_order,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(pid, v.title, v.summary, v.description, v.price_points, v.cover_url, v.category_id, JSON.stringify(v.tags), v.delivery_type, v.delivery_text, v.delivery_url, v.file_key, v.file_name, v.stock, v.status, v.sort_order, now(), now()).run();
      await audit(env, 'goods.created', pid, `${v.title} / ${v.price_points} 积分`);
      await invalidatePublicCache(request);
      const row = await env.DB.prepare('SELECT * FROM products WHERE id=?').bind(pid).first();
      return json({ ok: true, product: row }, 201);
    }
    const prodRoute = path.match(/^\/api\/admin\/products\/([A-Za-z0-9_\-]{1,64})$/);
    if (prodRoute) {
      const pid = prodRoute[1];
      const existing = await env.DB.prepare('SELECT * FROM products WHERE id=?').bind(pid).first();
      if (!existing) return fail(404, '商品不存在', 'PRODUCT_NOT_FOUND');
      if (method === 'PUT') {
        const parsed = parseProduct(await bodyJson(request));
        if (!parsed.ok) return fail(400, parsed.error, 'INVALID_ARGUMENT');
        const v = parsed.value;
        if (!await productCategoryOk(env, v.category_id)) return fail(400, '所选商品分类不存在', 'CATEGORY_NOT_FOUND');
        await env.DB.prepare(`UPDATE products SET title=?,summary=?,description=?,price_points=?,cover_url=?,category_id=?,tags=?,delivery_type=?,delivery_text=?,delivery_url=?,file_key=?,file_name=?,stock=?,status=?,sort_order=?,updated_at=? WHERE id=?`)
          .bind(v.title, v.summary, v.description, v.price_points, v.cover_url, v.category_id, JSON.stringify(v.tags), v.delivery_type, v.delivery_text, v.delivery_url, v.file_key, v.file_name, v.stock, v.status, v.sort_order, now(), pid).run();
        await audit(env, 'goods.updated', pid, `${v.title} / ${v.status}`);
        await invalidatePublicCache(request);
        const row = await env.DB.prepare('SELECT * FROM products WHERE id=?').bind(pid).first();
        return json({ ok: true, product: row });
      }
      if (method === 'DELETE') {
        const sold = await env.DB.prepare("SELECT COUNT(*) AS c FROM orders WHERE product_id=? AND status='DELIVERED'").bind(pid).first();
        if (Number(sold?.c || 0) > 0) {
          await env.DB.prepare("UPDATE products SET status='HIDDEN',updated_at=? WHERE id=?").bind(now(), pid).run();
          await audit(env, 'goods.hidden', pid, '已售出商品仅下架，保留订单交付');
          await invalidatePublicCache(request);
          return json({ ok: true, hidden: true, message: '该商品已有成交订单，已改为下架以保留用户已购内容。' });
        }
        await env.DB.prepare('DELETE FROM products WHERE id=?').bind(pid).run();
        await audit(env, 'goods.deleted', pid, existing.title);
        await invalidatePublicCache(request);
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
      if (b.clear === true) { await delSetting(env, 'yirenfu_api_key'); await audit(env, 'admin.api_key_cleared'); return json({ ok: true, ...await secretState(env) }); }
      const value = typeof b.value === 'string' ? b.value.trim() : '';
      if (value.length < 8 || value.length > 200 || /\s/.test(value)) return fail(400, 'API Key 需为 8-200 位且不含空白字符', 'INVALID_ARGUMENT');
      await setSetting(env, 'yirenfu_api_key', value);
      await audit(env, 'admin.api_key_updated');
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
    if (path === '/api/admin/users' && method === 'GET') return json(await listUsers(env, url));
    if (path === '/api/admin/audit' && method === 'GET') {
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || 30) || 30));
      const rows = await env.DB.prepare('SELECT id,action,target,detail,created_at FROM admin_audit ORDER BY created_at DESC LIMIT ?').bind(limit).all();
      return json({ items: rows.results || [] });
    }
    const userRoute = path.match(/^\/api\/admin\/users\/([A-Za-z0-9_\-]{1,64})(?:\/(reset-password|status|role))?$/);
    if (userRoute) {
      const targetId = userRoute[1], action = userRoute[2] || '';
      const target = await env.DB.prepare('SELECT id,email,role FROM users WHERE id=?').bind(targetId).first();
      if (!target) return fail(404, '用户不存在', 'USER_NOT_FOUND');
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
        await env.DB.prepare('UPDATE users SET disabled=?,updated_at=? WHERE id=?').bind(disabled ? 1 : 0, now(), targetId).run();
        if (disabled) await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(targetId).run();
        await audit(env, disabled ? 'user.disabled' : 'user.enabled', targetId, target.email);
        return json({ ok: true, disabled });
      }
      if (!action && method === 'DELETE') {
        await env.DB.batch([
          env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(targetId),
          env.DB.prepare('DELETE FROM purchase_intents WHERE user_id=?').bind(targetId),
          env.DB.prepare('DELETE FROM consumption_jobs WHERE user_id=?').bind(targetId),
          env.DB.prepare('DELETE FROM orders WHERE user_id=?').bind(targetId),
          env.DB.prepare('DELETE FROM users WHERE id=?').bind(targetId),
        ]);
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
  async fetch(request, env) {
    try {
      const response = await route(request, env);
      if (response) return response;
      if (request.method === 'GET' && env.ASSETS) {
        const assetUrl = new URL(request.url);
        if (assetUrl.pathname === '/admin') assetUrl.pathname = '/admin.html';
        else if (assetUrl.pathname === '/shop') assetUrl.pathname = '/shop.html';
        else if (assetUrl.pathname === '/account') assetUrl.pathname = '/account.html';
        else if (assetUrl.pathname === '/') assetUrl.pathname = '/index.html';
        const assetResponse = await env.ASSETS.fetch(new Request(assetUrl, request));
        return withStaticCache(assetResponse, assetUrl.pathname);
      }
      return fail(404, 'Not Found', 'NOT_FOUND');
    } catch (e) {
      if (e.message === 'BODY_TOO_LARGE') return fail(413, '请求内容过大', 'BODY_TOO_LARGE');
      if (e instanceof SyntaxError || e.message === 'INVALID_JSON') return fail(400, 'JSON 格式无效', 'INVALID_JSON');
      return fail(e.status || 500, e.status ? e.message : '服务器内部错误', e.code || 'INTERNAL_ERROR');
    }
  }
};

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import worker from '../src/index.js';

// Regression cover for the audit fixes: honest "used points", JSON 404 for the
// API, admin order paging, password throttling (including the safe degradation
// when 0010 has not been applied yet) and non-leaking registration errors.
let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch {}
const sqliteTest = (name, fn) => test(name, { skip: !DatabaseSync && 'requires Node 22 SQLite' }, fn);

const BASE_MIGRATIONS = ['0001_init.sql', '0002_users_and_admin.sql', '0003_products_and_orders.sql', '0004_user_admin_roles.sql', '0005_categories_and_tags.sql', '0006_bonus_points.sql', '0007_catalog_agent.sql', '0008_subscriptions_and_repeat.sql', '0009_agent_pairing.sql'];

async function makeDb({ withAuthLimits = true, failUsersInsert = false } = {}) {
  const raw = new DatabaseSync(':memory:');
  const migrations = [...BASE_MIGRATIONS];
  if (withAuthLimits) migrations.push('0010_auth_limits.sql');
  for (const name of migrations) raw.exec(await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  raw.exec(`INSERT INTO users(id,email,password_hash,created_at,role) VALUES
    ('usr_user','user@example.com','100000.salt.hash','2026-01-01','user'),
    ('usr_admin','admin@example.com','100000.salt.hash','2026-01-01','admin');
    INSERT INTO products(id,title,price_points,delivery_type,delivery_text,stock,status,created_at,updated_at)
    VALUES('p_one','普通商品',10,'TEXT','交付',null,'ACTIVE','2026-01-01','2026-01-01'),
          ('p_two','另一个商品',30,'TEXT','交付二',null,'ACTIVE','2026-01-01','2026-01-01');`);
  for (const [token, user, role] of [['user-token', 'usr_user', 'user'], ['admin-token', 'usr_admin', 'admin']]) {
    raw.prepare('INSERT INTO sessions(token_hash,user_id,role,expires_at,created_at) VALUES(?,?,?,?,?)')
      .run(createHash('sha256').update(token).digest('base64url'), user, role, 9999999999, '2026-01-01');
  }
  // Two delivered orders (10 + 30) plus one pending order that must not be counted.
  raw.exec(`INSERT INTO orders(idempotency_key,order_no,user_id,product_id,title,price_points,delivery_type,status,created_at,delivered_at,bonus_points_used)
    VALUES('k1','NO1','usr_user','p_one','普通商品',10,'TEXT','DELIVERED','2026-01-02','2026-01-02',4),
           ('k2','NO2','usr_user','p_two','另一个商品',30,'TEXT','DELIVERED','2026-01-03','2026-01-03',0),
           ('k3','NO3','usr_user','p_one','普通商品',10,'TEXT','PENDING','2026-01-04',NULL,10);`);
  const db = {
    raw,
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() { return raw.prepare(sql).get(...values) || null; },
        async all() { return { results: raw.prepare(sql).all(...values) }; },
        runSync() {
          if (failUsersInsert && /^\s*INSERT INTO users\(/.test(sql)) {
            throw new Error('D1_ERROR: no such column: nickname at offset 3: SQLITE_ERROR');
          }
          const result = raw.prepare(sql).run(...values);
          return { meta: { changes: Number(result.changes) } };
        },
        async run() { return this.runSync(); },
      };
    },
    async batch(statements) {
      raw.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(statement.runSync()); raw.exec('COMMIT'); return results; }
      catch (error) { raw.exec('ROLLBACK'); throw error; }
    },
  };
  return { raw, db };
}

const call = (env, path, { method = 'GET', body, admin = false, token, ip } = {}) => worker.fetch(new Request('https://shop.test' + path, {
  method,
  headers: {
    cookie: admin ? 'onepay_admin_session=admin-token' : `onepay_session=${token || 'user-token'}`,
    'content-type': 'application/json',
    ...(ip ? { 'cf-connecting-ip': ip } : {}),
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}), env);

sqliteTest('/api/access reports the real spend of delivered orders', async (t) => {
  const { raw, db } = await makeDb(); t.after(() => raw.close());
  const response = await call({ DB: db }, '/api/access');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.used_points, 40, 'only delivered orders 10 + 30 count');
  assert.equal(data.used, 40, 'legacy alias stays in sync');
  assert.equal(data.bonus_used, 4, 'bonus part is still reported separately');
});

sqliteTest('unknown API paths answer with a parseable JSON 404', async (t) => {
  const { raw, db } = await makeDb(); t.after(() => raw.close());
  const env = { DB: db };
  for (const [path, method] of [['/api/nope', 'GET'], ['/api/products/xyz/unknown', 'POST'], ['/api', 'GET']]) {
    const response = await call(env, path, { method });
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.match(response.headers.get('content-type') || '', /application\/json/);
    const data = await response.json();
    assert.equal(data.error_code, 'NOT_FOUND');
  }
});

sqliteTest('admin order list pages and filters by status', async (t) => {
  const { raw, db } = await makeDb(); t.after(() => raw.close());
  const env = { DB: db };
  const firstPage = await (await call(env, '/api/admin/orders?limit=2&offset=0', { admin: true })).json();
  assert.equal(firstPage.items.length, 2);
  assert.equal(firstPage.has_more, true);
  assert.equal(firstPage.next_offset, 2);
  const secondPage = await (await call(env, '/api/admin/orders?limit=2&offset=2', { admin: true })).json();
  assert.equal(secondPage.items.length, 1);
  assert.equal(secondPage.has_more, false);
  const keys = [...firstPage.items, ...secondPage.items].map(order => order.key);
  assert.equal(new Set(keys).size, 3, 'pages must not overlap');
  const pending = await (await call(env, '/api/admin/orders?status=PENDING', { admin: true })).json();
  assert.deepEqual(pending.items.map(order => order.key), ['k3']);
  assert.equal(pending.status, 'PENDING');
});

sqliteTest('repeated password failures are throttled per account and recover after success', async (t) => {
  const { raw, db } = await makeDb(); t.after(() => raw.close());
  const env = { DB: db };
  const attempt = (email, ip) => call(env, '/api/auth/login', {
    method: 'POST', body: { email, password: 'definitely-wrong' }, ip,
  });
  for (let index = 0; index < 8; index++) {
    assert.equal((await attempt('ghost@example.com', '203.0.113.10')).status, 401, `attempt ${index + 1}`);
  }
  const blocked = await attempt('ghost@example.com', '203.0.113.11');
  assert.equal(blocked.status, 429, 'the account budget is exhausted, not only the client one');
  assert.equal(blocked.headers.get('retry-after'), '300');
  assert.equal((await blocked.json()).error_code, 'AUTH_RATE_LIMITED');
  // A different account from the same client address is unaffected.
  assert.equal((await attempt('other@example.com', '203.0.113.10')).status, 401);
  // Counting never stores the raw address or the email.
  const scopes = raw.prepare('SELECT scope FROM auth_limits').all().map(row => row.scope);
  assert.ok(scopes.every(scope => scope.startsWith('auth-')));
  assert.ok(scopes.every(scope => !scope.includes('ghost') && !scope.includes('203.0.113')));
});

sqliteTest('password limits degrade to "no throttle" before 0010 is applied', async (t) => {
  const { raw, db } = await makeDb({ withAuthLimits: false }); t.after(() => raw.close());
  const env = { DB: db };
  for (let index = 0; index < 12; index++) {
    const response = await call(env, '/api/auth/login', {
      method: 'POST', body: { email: 'ghost@example.com', password: 'definitely-wrong' }, ip: '203.0.113.12',
    });
    assert.equal(response.status, 401, 'a missing table must never lock anyone out');
  }
});

sqliteTest('registration failures do not echo the database error', async (t) => {
  const { raw, db } = await makeDb({ failUsersInsert: true }); t.after(() => raw.close());
  const response = await call({ DB: db }, '/api/auth/register', {
    method: 'POST', body: { email: 'new@example.com', password: 'a-long-password' }, ip: '203.0.113.13',
  });
  assert.equal(response.status, 500);
  const data = await response.json();
  assert.equal(data.error_code, 'REGISTER_FAILED');
  assert.ok(!/SQLITE|D1_ERROR|nickname/i.test(data.error), 'internal driver details must stay server side');
});

sqliteTest('/api/orders reports lifetime totals next to the page of orders', async (t) => {
  const { raw, db } = await makeDb(); t.after(() => raw.close());
  const response = await call({ DB: db }, '/api/orders?offset=0');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.items.length, 3);
  assert.deepEqual(data.totals, { total: 3, delivered: 2, pending: 1 });
  const secondPage = await (await call({ DB: db }, '/api/orders?offset=2')).json();
  assert.deepEqual(secondPage.items.map(order => order.key), ['k1']);
  assert.deepEqual(secondPage.totals, data.totals, 'totals describe the account, not the page');
});

test('the admin console never falls back to native confirm() or prompt()', async () => {
  const html = await readFile(new URL('../public/admin.html', import.meta.url), 'utf8');
  assert.ok(!/\bconfirm\(/.test(html), 'use askConfirm() so dialogs work inside embedded previews');
  assert.ok(!/(?<![.\w])prompt\(/.test(html), 'passwords must not be typed into a native prompt');
  assert.match(html, /id="askDialog"/);
  assert.match(html, /function askConfirm\(/);
  assert.match(html, /function askPassword\(/);
});

test('browser code can mint idempotency keys without crypto.randomUUID', async () => {
  const store = await readFile(new URL('../public/storefront.js', import.meta.url), 'utf8');
  assert.match(store, /function uuid\(\)/);
  assert.match(store, /crypto\.getRandomValues/);
  const admin = await readFile(new URL('../public/admin.html', import.meta.url), 'utf8');
  assert.match(admin, /function uuid\(\)/);
  for (const page of ['shop.html', 'account.html']) {
    assert.ok(!/crypto\.randomUUID/.test(await readFile(new URL(`../public/${page}`, import.meta.url), 'utf8')), `${page} should use Store.uuid()`);
  }
});

sqliteTest('admins can publish or hide a product without rewriting the whole row', async (t) => {
  const { raw, db } = await makeDb(); t.after(() => raw.close());
  const env = { DB: db };
  const hidden = await call(env, '/api/admin/products/p_one/status', { method: 'POST', admin: true, body: { status: 'hidden' } });
  assert.equal(hidden.status, 200);
  assert.deepEqual(await hidden.json(), { ok: true, id: 'p_one', status: 'HIDDEN' });
  assert.equal(raw.prepare("SELECT status FROM products WHERE id='p_one'").get().status, 'HIDDEN', 'status is lowercased into the stored enum');
  assert.equal(raw.prepare("SELECT price_points FROM products WHERE id='p_one'").get().price_points, 10, 'other columns stay untouched');
  const invalid = await call(env, '/api/admin/products/p_one/status', { method: 'POST', admin: true, body: { status: 'DELETED' } });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error_code, 'INVALID_ARGUMENT');
  const missing = await call(env, '/api/admin/products/nope/status', { method: 'POST', admin: true, body: { status: 'ACTIVE' } });
  assert.equal(missing.status, 404);
  const anonymous = await call(env, '/api/admin/products/p_one/status', { method: 'POST', admin: false, body: { status: 'ACTIVE' } });
  assert.ok([401, 403].includes(anonymous.status), 'a shopper session must not publish products');
});

test('unknown pages answer with the friendly HTML 404 instead of an empty body', async () => {
  const html = await readFile(new URL('../public/404.html', import.meta.url), 'utf8');
  assert.match(html, /这件东西可能已经下架/);
  assert.match(html, /href="\/shop"/);
  const assets = {
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/404.html') return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      return new Response('not found', { status: 404 });
    },
  };
  const response = await worker.fetch(new Request('https://shop.test/typo-page', { headers: { accept: 'text/html' } }), { ASSETS: assets });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(await response.text(), /可能已经下架/);
  // A non-HTML client (API, curl) keeps the plain JSON 404.
  const api = await worker.fetch(new Request('https://shop.test/api/nope', { headers: { accept: 'application/json' } }), { ASSETS: assets });
  assert.equal((await api.json()).error_code, 'NOT_FOUND');
});

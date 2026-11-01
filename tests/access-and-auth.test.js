import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, pbkdf2Sync } from 'node:crypto';
import worker from '../src/index.js';
import { policyFor } from '../src/cache.js';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch {}
const sqliteTest = (name, fn) => test(name, { skip: !DatabaseSync && 'requires Node 22 SQLite' }, fn);

const MIGRATIONS = [
  '0001_init.sql', '0002_users_and_admin.sql', '0003_products_and_orders.sql', '0004_user_admin_roles.sql',
  '0005_categories_and_tags.sql', '0006_bonus_points.sql', '0007_catalog_agent.sql',
  '0008_subscriptions_and_repeat.sql', '0009_agent_pairing.sql', '0010_auth_throttle.sql',
];

function passwordHash(password) {
  const salt = 'test-salt';
  return `100000.${salt}.${pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('base64url')}`;
}

async function makeDb() {
  const raw = new DatabaseSync(':memory:');
  for (const name of MIGRATIONS) raw.exec(await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  raw.exec(`INSERT INTO users(id,email,password_hash,created_at,role) VALUES
    ('usr_a','a@example.com','${passwordHash('correct-horse-battery')}','2026-01-01','user'),
    ('usr_admin','admin@example.com','${passwordHash('admin-horse-battery')}','2026-01-01','admin');
    INSERT INTO products(id,title,summary,description,price_points,delivery_type,delivery_text,stock,status,created_at,updated_at)
    VALUES('prd_live','在售商品','副标题','完整详情内容',12,'TEXT','交付文本',5,'ACTIVE','2026-01-01','2026-01-01'),
      ('prd_hidden','已下架商品','','',12,'TEXT','x',5,'HIDDEN','2026-01-01','2026-01-01');`);
  for (const [token, user, role] of [['user-token', 'usr_a', 'user'], ['admin-token', 'usr_admin', 'admin']]) {
    raw.prepare('INSERT INTO sessions(token_hash,user_id,role,expires_at,created_at) VALUES(?,?,?,?,?)')
      .run(createHash('sha256').update(token).digest('base64url'), user, role, 9999999999, '2026-01-01');
  }
  return {
    raw,
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() { return raw.prepare(sql).get(...values) || null; },
        async all() { return { results: raw.prepare(sql).all(...values) }; },
        runSync() { return { meta: { changes: Number(raw.prepare(sql).run(...values).changes) } }; },
        async run() { return this.runSync(); },
      };
    },
    async batch(statements) {
      raw.exec('BEGIN');
      try { const rows = statements.map(stmt => stmt.runSync()); raw.exec('COMMIT'); return rows; }
      catch (error) { raw.exec('ROLLBACK'); throw error; }
    },
  };
}

function req(path, { method = 'GET', body, cookie = 'onepay_session=user-token', ip = '203.0.113.10' } = {}) {
  const headers = { 'cf-connecting-ip': ip };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new Request('https://shop.test' + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

// The throttle key is hash(ip|email); rebuild it to inspect a single identity.
const loginKeyFor = (ip, email = 'a@example.com') => 'login:' + createHash('sha256').update(`${ip}|${email}`).digest('base64url');
function attemptsFor(DB, ip, email) {
  return DB.raw.prepare('SELECT COUNT(*) AS n FROM auth_attempts WHERE key=?').get(loginKeyFor(ip, email)).n;
}

test('product detail reads are cached with the catalog generation', () => {
  assert.equal(policyFor('/api/products').scope, 'catalog');
  assert.equal(policyFor('/api/products/prd_live').scope, 'catalog');
  assert.equal(policyFor('/api/products/prd_live/extra'), null);
  assert.equal(policyFor('/api/access'), null);
});

sqliteTest('public product detail exposes only active products and private headers', async () => {
  const DB = await makeDb();
  try {
    const live = await worker.fetch(req('/api/products/prd_live', { cookie: '' }), { DB });
    assert.equal(live.status, 200);
    const data = await live.json();
    assert.equal(data.product.title, '在售商品');
    assert.equal(data.product.description, '完整详情内容');
    assert.equal(data.product.price_points, 12);
    assert.ok(!('delivery_text' in data.product), 'delivery content must never appear on the public detail endpoint');
    assert.ok(!('file_key' in data.product));
    const hidden = await worker.fetch(req('/api/products/prd_hidden', { cookie: '' }), { DB });
    assert.equal(hidden.status, 404);
    assert.equal((await hidden.json()).error_code, 'PRODUCT_NOT_FOUND');
  } finally { DB.raw.close(); }
});

sqliteTest('access summary reports lifetime spend, delivered orders and pending count', async () => {
  const DB = await makeDb();
  try {
    const insert = DB.raw.prepare(`INSERT INTO orders(idempotency_key,order_no,user_id,product_id,title,price_points,bonus_points_used,delivery_type,delivery_text,status,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    insert.run('ord-one', 'NO1', 'usr_a', 'prd_live', '在售商品', 12, 0, 'TEXT', 'x', 'DELIVERED', '2026-01-01T00:00:00.000Z');
    insert.run('ord-pending', 'NO2', 'usr_a', 'prd_live', '在售商品', 30, 0, 'TEXT', 'x', 'PENDING', '2026-01-02T00:00:00.000Z');
    insert.run('ord-failed', 'NO3', 'usr_a', 'prd_live', '在售商品', 99, 0, 'TEXT', 'x', 'FAILED', '2026-01-03T00:00:00.000Z');
    const data = await (await worker.fetch(req('/api/access'), { DB })).json();
    assert.equal(data.spent_points, 12);
    assert.equal(data.order_count, 1);
    assert.equal(data.pending_orders, 1);
    assert.equal(data.bonus_used, 0);
    assert.equal(data.onepay_used, 12);
    assert.equal(data.total_points, null, 'no API key means the upstream balance stays unknown');
  } finally { DB.raw.close(); }
});

sqliteTest('repeated wrong passwords are throttled before any password hashing', async () => {
  const DB = await makeDb();
  try {
    const attempt = (password, ip = '198.51.100.7') => worker.fetch(
      req('/api/auth/login', { method: 'POST', cookie: '', ip, body: { email: 'a@example.com', password } }), { DB });
    for (let i = 0; i < 8; i++) assert.equal((await attempt('wrong-password-1')).status, 401);
    const blocked = await attempt('wrong-password-1');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('retry-after'), '900');
    assert.equal((await blocked.json()).error_code, 'AUTH_RATE_LIMITED');
    assert.equal((await attempt('correct-horse-battery')).status, 429, 'the correct password is also blocked while the window is open');
    assert.equal((await attempt('correct-horse-battery', '198.51.100.8')).status, 200, 'another address is unaffected');
    // A successful login clears the counter for that identity only.
    assert.equal(attemptsFor(DB, '198.51.100.8'), 0);
    assert.equal(attemptsFor(DB, '198.51.100.7'), 1);
    assert.equal((await attempt('wrong-password-2', '198.51.100.8')).status, 401);
    assert.equal(attemptsFor(DB, '198.51.100.8'), 1);
  } finally { DB.raw.close(); }
});

sqliteTest('administrator login throttles separately from the store login', async () => {
  const DB = await makeDb();
  try {
    const adminLogin = password => worker.fetch(req('/api/admin/login', { method: 'POST', cookie: '', ip: '192.0.2.9', body: { email: 'admin@example.com', password } }), { DB });
    for (let i = 0; i < 8; i++) assert.equal((await adminLogin('nope-nope-nope')).status, 401);
    assert.equal((await adminLogin('nope-nope-nope')).status, 429);
    const shopLogin = await worker.fetch(req('/api/auth/login', { method: 'POST', cookie: '', ip: '192.0.2.9', body: { email: 'a@example.com', password: 'correct-horse-battery' } }), { DB });
    assert.equal(shopLogin.status, 200);
  } finally { DB.raw.close(); }
});

sqliteTest('users can change their own password and other sessions are revoked', async () => {
  const DB = await makeDb();
  try {
    const wrong = await worker.fetch(req('/api/auth/password', { method: 'POST', body: { current_password: 'wrong-one-here', new_password: 'brand-new-secret' } }), { DB });
    assert.equal(wrong.status, 403);
    const same = await worker.fetch(req('/api/auth/password', { method: 'POST', body: { current_password: 'correct-horse-battery', new_password: 'correct-horse-battery' } }), { DB });
    assert.equal(same.status, 400);
    const other = createHash('sha256').update('other-device').digest('base64url');
    DB.raw.prepare('INSERT INTO sessions(token_hash,user_id,role,expires_at,created_at) VALUES(?,?,?,?,?)').run(other, 'usr_a', 'user', 9999999999, '2026-01-01');
    const changed = await worker.fetch(req('/api/auth/password', { method: 'POST', body: { current_password: 'correct-horse-battery', new_password: 'brand-new-secret' } }), { DB });
    assert.equal(changed.status, 200);
    assert.equal(DB.raw.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id='usr_a'").get().n, 1, 'only the current device stays signed in');
    assert.equal((await worker.fetch(req('/api/auth/me'), { DB })).status, 200);
    const login = await worker.fetch(req('/api/auth/login', { method: 'POST', cookie: '', ip: '203.0.113.99', body: { email: 'a@example.com', password: 'brand-new-secret' } }), { DB });
    assert.equal(login.status, 200);
  } finally { DB.raw.close(); }
});

sqliteTest('administrator order search filters by status and paginates with totals', async () => {
  const DB = await makeDb();
  try {
    const insert = DB.raw.prepare(`INSERT INTO orders(idempotency_key,order_no,user_id,product_id,title,price_points,bonus_points_used,delivery_type,delivery_text,status,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    insert.run('ord-p1', 'NO-P1', 'usr_a', 'prd_live', '在售商品', 10, 0, 'TEXT', 'x', 'PENDING', '2026-01-01T00:00:00.000Z');
    insert.run('ord-d1', 'NO-D1', 'usr_a', 'prd_live', '在售商品', 10, 0, 'TEXT', 'x', 'DELIVERED', '2026-01-02T00:00:00.000Z');
    insert.run('ord-d2', 'NO-D2', 'usr_a', 'prd_live', '另一件商品', 10, 0, 'TEXT', 'x', 'DELIVERED', '2026-01-03T00:00:00.000Z');
    const admin = cookie => ({ method: 'GET', cookie });
    const all = await (await worker.fetch(req('/api/admin/orders?limit=2', admin('onepay_admin_session=admin-token')), { DB })).json();
    assert.equal(all.total, 3);
    assert.equal(all.pending_total, 1);
    assert.equal(all.items.length, 2);
    assert.equal(all.has_more, true);
    const next = await (await worker.fetch(req('/api/admin/orders?limit=2&offset=2', admin('onepay_admin_session=admin-token')), { DB })).json();
    assert.equal(next.items.length, 1);
    assert.equal(next.has_more, false);
    const pending = await (await worker.fetch(req('/api/admin/orders?status=PENDING', admin('onepay_admin_session=admin-token')), { DB })).json();
    assert.deepEqual(pending.items.map(item => item.order_no), ['NO-P1']);
    const search = await (await worker.fetch(req('/api/admin/orders?q=另一件', admin('onepay_admin_session=admin-token')), { DB })).json();
    assert.deepEqual(search.items.map(item => item.order_no), ['NO-D2']);
    const userTried = await worker.fetch(req('/api/admin/orders'), { DB });
    assert.equal(userTried.status, 401, 'shop sessions cannot read admin order lists');
  } finally { DB.raw.close(); }
});

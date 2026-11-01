import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { adjustBonus } from '../src/bonus.js';
import worker from '../src/index.js';

// Regression coverage for the hardening pass: auth rate limits, honest local
// spend totals, paginated admin orders and corrupt-ledger resilience.
let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch {}
const sqliteTest = (name, fn) => test(name, { skip: !DatabaseSync && 'requires Node 22 SQLite' }, fn);

async function makeDb() {
  const raw = new DatabaseSync(':memory:');
  for (const name of ['0001_init.sql', '0002_users_and_admin.sql', '0003_products_and_orders.sql', '0004_user_admin_roles.sql', '0005_categories_and_tags.sql', '0006_bonus_points.sql', '0007_catalog_agent.sql', '0008_subscriptions_and_repeat.sql', '0009_agent_pairing.sql']) {
    raw.exec(await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  }
  raw.exec(`INSERT INTO users(id,email,password_hash,created_at,role) VALUES
    ('usr_user','user@example.com','x','2026-01-01','user'),
    ('usr_admin','admin@example.com','x','2026-01-01','admin');
    INSERT INTO products(id,title,price_points,delivery_type,delivery_text,stock,status,created_at,updated_at)
    VALUES('p_test','测试商品',10,'TEXT','测试交付',5,'ACTIVE','2026-01-01','2026-01-01');`);
  for (const [token, user] of [['user-token', 'usr_user'], ['admin-token', 'usr_admin']]) {
    const hash = createHash('sha256').update(token).digest('base64url');
    raw.prepare('INSERT INTO sessions(token_hash,user_id,role,expires_at,created_at) VALUES(?,?,?,?,?)').run(hash, user, user === 'usr_admin' ? 'admin' : 'user', 9999999999, '2026-01-01');
  }
  return {
    raw,
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() { return raw.prepare(sql).get(...values) || null; },
        async all() { return { results: raw.prepare(sql).all(...values) }; },
        runSync() { const r = raw.prepare(sql).run(...values); return { meta: { changes: Number(r.changes) } }; },
        async run() { return this.runSync(); },
      };
    },
    async batch(statements) {
      raw.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(statement.runSync()); raw.exec('COMMIT'); return results; }
      catch (error) { raw.exec('ROLLBACK'); throw error; }
    },
  };
}

const request = (path, { admin = false, method = 'GET', body, ip } = {}) => new Request('https://example.test' + path, {
  method,
  headers: {
    cookie: (admin ? 'onepay_admin_session=admin-token' : 'onepay_session=user-token'),
    'content-type': 'application/json',
    ...(ip ? { 'cf-connecting-ip': ip } : {}),
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

sqliteTest('repeated failed logins from one IP are rate limited with retry-after', async () => {
  const DB = await makeDb(), env = { DB }; const t = DB.raw.prepare('SELECT COUNT(*) AS n FROM agent_pair_limits').get().n;
  assert.equal(t, 0);
  const attempt = () => worker.fetch(request('/api/auth/login', { method: 'POST', ip: '203.0.113.9', body: { email: 'user@example.com', password: 'wrong-password' } }), env);
  for (let i = 0; i < 10; i++) assert.equal((await attempt()).status, 401);
  const blocked = await attempt();
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '300');
  assert.equal((await blocked.json()).error_code, 'RATE_LIMITED');
  // A different client is not affected.
  const other = await worker.fetch(request('/api/auth/login', { method: 'POST', ip: '198.51.100.7', body: { email: 'user@example.com', password: 'wrong-password' } }), env);
  assert.equal(other.status, 401);
  // Admin login keeps its own counter.
  assert.equal((await worker.fetch(request('/api/admin/login', { method: 'POST', ip: '203.0.113.9', body: { email: 'admin@example.com', password: 'wrong-password' } }), env)).status, 401);
  DB.raw.close();
});

sqliteTest('registration attempts are rate limited per IP', async () => {
  const DB = await makeDb(), env = { DB };
  const attempt = () => worker.fetch(request('/api/auth/register', { method: 'POST', ip: '192.0.2.4', body: { email: 'fresh@example.com', password: 'long-enough-password' } }), env);
  // The first attempt registers the address; later attempts hit the email conflict but still consume budget.
  assert.equal((await attempt()).status, 201);
  for (let i = 0; i < 9; i++) assert.equal((await attempt()).status, 409);
  assert.equal((await attempt()).status, 429);
  DB.raw.close();
});

sqliteTest('/api/access reports locally computed used_points from delivered orders', async () => {
  const DB = await makeDb(), env = { DB };
  await adjustBonus(env, { userId: 'usr_user', actorId: 'usr_admin', delta: 20, reason: '奖励', key: 'grant-access' });
  const purchase = await worker.fetch(request('/api/products/p_test/purchase', { method: 'POST', body: { idempotency_key: 'order-access-1' } }), env);
  assert.equal(purchase.status, 200);
  const access = await worker.fetch(request('/api/access'), env);
  const data = await access.json();
  assert.equal(data.used_points, 10);
  assert.equal(data.bonus_used, 10);
  assert.equal(data.bonus_points, 10);
  DB.raw.close();
});

sqliteTest('admin orders list paginates with has_more and stable offsets', async () => {
  const DB = await makeDb(), env = { DB };
  for (const [key, at] of [['ord-a', '2026-01-01T00:00:00.000Z'], ['ord-b', '2026-01-02T00:00:00.000Z'], ['ord-c', '2026-01-03T00:00:00.000Z']]) {
    DB.raw.prepare(`INSERT INTO orders(idempotency_key,order_no,user_id,product_id,title,price_points,delivery_type,delivery_text,status,created_at)
      VALUES(?,'NO-' || ?, 'usr_user','p_test','测试商品',10,'TEXT','内容','DELIVERED',?)`).run(key, key, at);
  }
  const first = await (await worker.fetch(request('/api/admin/orders?limit=2&offset=0', { admin: true }), env)).json();
  assert.equal(first.items.length, 2);
  assert.equal(first.has_more, true);
  assert.equal(first.next_offset, 2);
  assert.equal(first.items[0].key, 'ord-c');
  const second = await (await worker.fetch(request('/api/admin/orders?limit=2&offset=2', { admin: true }), env)).json();
  assert.equal(second.items.length, 1);
  assert.equal(second.has_more, false);
  assert.equal(second.items[0].key, 'ord-a');
  DB.raw.close();
});

sqliteTest('/api/consumptions survives corrupt ledger JSON', async () => {
  const DB = await makeDb(), env = { DB };
  DB.raw.prepare(`INSERT INTO consumption_jobs(idempotency_key,user_id,amount,reason,status,response_json,created_at,updated_at)
    VALUES('job-corrupt','usr_user',5,'测试','UNKNOWN','not-json{','2026-01-01','2026-01-01')`).run();
  const response = await worker.fetch(request('/api/consumptions'), env);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.items.length, 1);
  assert.deepEqual(data.items[0].response, {});
  assert.equal(data.items[0].status, 'UNKNOWN');
  DB.raw.close();
});

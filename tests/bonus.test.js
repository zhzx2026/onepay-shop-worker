import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { bonusBalance, adjustBonus, reserveOrder, refundOrder } from '../src/bonus.js';
import worker from '../src/index.js';

// Node 22's built-in SQLite exercises the real migration and transactional SQL.
// Node 20 remains supported for the app; SQLite-specific tests are skipped there.
let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch {}
const sqliteTest = (name, fn) => test(name, { skip: !DatabaseSync && 'requires Node 22 SQLite' }, fn);

async function makeDb({ beforeSubscriptionMigration = false } = {}) {
  const raw = new DatabaseSync(':memory:');
  const migrations = ['0001_init.sql', '0002_users_and_admin.sql', '0003_products_and_orders.sql', '0004_user_admin_roles.sql', '0005_categories_and_tags.sql', '0006_bonus_points.sql', '0007_catalog_agent.sql'];
  if (!beforeSubscriptionMigration) migrations.push('0008_subscriptions_and_repeat.sql', '0009_agent_pairing.sql', '0010_auth_throttle.sql');
  for (const name of migrations) {
    raw.exec(await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  }
  raw.exec(`INSERT INTO users(id,email,password_hash,created_at,role) VALUES
    ('usr_user','user@example.com','x','2026-01-01','user'),
    ('usr_admin','admin@example.com','x','2026-01-01','admin');
    INSERT INTO products(id,title,price_points,delivery_type,delivery_text,stock,status,created_at,updated_at)
    VALUES('p_test','测试商品',10,'TEXT','测试交付',2,'ACTIVE','2026-01-01','2026-01-01');`);
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

const request = (path, { admin = false, method = 'GET', body } = {}) => new Request('https://example.test' + path, {
  method,
  headers: { cookie: (admin ? 'onepay_admin_session=admin-token' : 'onepay_session=user-token'), 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

sqliteTest('bonus adjustments are atomic, bounded and idempotent', async () => {
  const DB = await makeDb(), env = { DB };
  const base = { userId: 'usr_user', actorId: 'usr_admin', delta: 12, reason: '活动奖励', key: 'adjust-1' };
  assert.deepEqual(await adjustBonus(env, base), { ok: true, balance: 12, delta: 12 });
  assert.deepEqual(await adjustBonus(env, base), { ok: true, balance: 12, delta: 12 });
  assert.equal(await bonusBalance(env, 'usr_user'), 12);
  assert.equal((await adjustBonus(env, { ...base, delta: 11 })).code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await adjustBonus(env, { ...base, key: 'adjust-2', delta: -13 })).code, 'BALANCE_LIMIT');
  assert.equal(await bonusBalance(env, 'usr_user'), 12);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action='user.bonus_adjusted'").get().n, 1);
  DB.raw.close();
});

sqliteTest('order reservation and refund atomically move stock and bonus exactly once', async () => {
  const DB = await makeDb(), env = { DB };
  await adjustBonus(env, { userId: 'usr_user', actorId: 'usr_admin', delta: 4, reason: '测试', key: 'grant' });
  assert.equal(await reserveOrder(env, { productId: 'p_test', userId: 'usr_user', key: 'order-1', orderNo: 'NO1' }), true);
  assert.equal(await bonusBalance(env, 'usr_user'), 0);
  assert.equal(DB.raw.prepare('SELECT bonus_points_used FROM orders').get().bonus_points_used, 4);
  assert.equal(await reserveOrder(env, { productId: 'p_test', userId: 'usr_user', key: 'order-1', orderNo: 'NO2' }), false);
  assert.equal(DB.raw.prepare('SELECT stock FROM products').get().stock, 1);
  DB.raw.prepare("UPDATE orders SET processing_token='current' WHERE idempotency_key='order-1'").run();
  assert.equal(await refundOrder(env, 'order-1', 'stale'), false);
  assert.equal(await bonusBalance(env, 'usr_user'), 0);
  assert.equal(await refundOrder(env, 'order-1', 'current'), true);
  assert.equal(await refundOrder(env, 'order-1', 'current'), false);
  assert.equal(await bonusBalance(env, 'usr_user'), 4);
  assert.equal(DB.raw.prepare('SELECT stock FROM products').get().stock, 2);
  DB.raw.close();
});

sqliteTest('admin-only bonus grants fund local-only delivery without onepay and are not double spent', async () => {
  const DB = await makeDb(), env = { DB };
  const unauthorized = await worker.fetch(request('/api/admin/users/usr_user/bonus', { method: 'POST', body: { delta: 20, reason: '奖励', idempotency_key: 'grant1' } }), env);
  assert.equal(unauthorized.status, 401);
  const grant = await worker.fetch(request('/api/admin/users/usr_user/bonus', { admin: true, method: 'POST', body: { delta: 20, reason: '奖励', idempotency_key: 'grant1' } }), env);
  assert.equal(grant.status, 200);
  const purchase = () => worker.fetch(request('/api/products/p_test/purchase', { method: 'POST', body: { idempotency_key: 'order-local' } }), env);
  const result = await purchase(); assert.equal(result.status, 200);
  const data = await result.json(); assert.equal(data.order.bonus_points_used, 10); assert.equal(data.delivery.text, '测试交付');
  const again = await purchase(); assert.equal(again.status, 200); assert.equal((await again.json()).already_delivered, true);
  assert.equal(await bonusBalance(env, 'usr_user'), 10);
  assert.equal(DB.raw.prepare('SELECT stock FROM products').get().stock, 1);
  const access = await worker.fetch(request('/api/access'), env);
  assert.deepEqual([(await access.json()).bonus_points, access.headers.get('cache-control')], [10, 'private, no-store']);
  DB.raw.close();
});

sqliteTest('mixed payment deducts only the remainder upstream and rolls back both stock and bonus on confirmed failure', async t => {
  const DB = await makeDb(), env = { DB, YIRENFU_API_KEY: 'fake-key' };
  DB.raw.exec('UPDATE products SET allow_repeat=1');
  await adjustBonus(env, { userId: 'usr_user', actorId: 'usr_admin', delta: 3, reason: '测试', key: 'grant2' });
  const oldFetch = globalThis.fetch; t.after(() => { globalThis.fetch = oldFetch; DB.raw.close(); });
  let mode = 'success', amount;
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/capabilities')) return new Response(JSON.stringify({ capabilities: { entitlement_query: true, consumption: true } }));
    if (path.endsWith('/access')) return new Response(JSON.stringify({ requires_consumption: true, access_granted: true, remaining: 100 }));
    if (path.endsWith('/consume')) { amount = JSON.parse(options.body).amount; return new Response(JSON.stringify(mode === 'success' ? { status: 'SUCCEEDED', confirmed: true } : { status: 'FAILED', confirmed: false })); }
    throw new Error('unexpected endpoint ' + path);
  };
  let r = await worker.fetch(request('/api/products/p_test/purchase', { method: 'POST', body: { idempotency_key: 'mixed-1' } }), env);
  assert.equal(r.status, 200); assert.equal(amount, 7); assert.equal((await r.json()).order.bonus_points_used, 3);
  assert.equal(await bonusBalance(env, 'usr_user'), 0);
  await adjustBonus(env, { userId: 'usr_user', actorId: 'usr_admin', delta: 3, reason: '测试', key: 'grant3' });
  mode = 'failed';
  r = await worker.fetch(request('/api/products/p_test/purchase', { method: 'POST', body: { idempotency_key: 'mixed-2' } }), env);
  assert.equal(r.status, 409); assert.equal(await bonusBalance(env, 'usr_user'), 3);
  assert.equal(DB.raw.prepare('SELECT stock FROM products').get().stock, 1);
});


sqliteTest('unknown upstream results keep reservations until the original id resolves', async t => {
  const DB = await makeDb(), env = { DB, YIRENFU_API_KEY: 'fake-key' };
  await adjustBonus(env, { userId: 'usr_user', actorId: 'usr_admin', delta: 4, reason: '测试', key: 'grant-unknown' });
  const oldFetch = globalThis.fetch; t.after(() => { globalThis.fetch = oldFetch; DB.raw.close(); });
  let resolution = 'UNKNOWN', consumes = 0, queries = 0;
  globalThis.fetch = async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/capabilities')) return Response.json({ capabilities: { entitlement_query: true, consumption: true } });
    if (path.endsWith('/access')) return Response.json({ requires_consumption: true, access_granted: true, remaining: 100 });
    if (path.endsWith('/consume')) { consumes++; throw new Error('connection lost after submit'); }
    if (path.endsWith('/consumption')) { queries++; return Response.json(resolution === 'SUCCEEDED' ? { status: resolution, confirmed: true } : { status: resolution }); }
    throw new Error('unexpected endpoint ' + path);
  };
  const purchase = () => worker.fetch(request('/api/products/p_test/purchase', { method: 'POST', body: { idempotency_key: 'unknown-order' } }), env);
  assert.equal((await purchase()).status, 202);
  assert.equal(await bonusBalance(env, 'usr_user'), 0);
  assert.equal(DB.raw.prepare('SELECT stock FROM products').get().stock, 1);
  assert.equal(DB.raw.prepare('SELECT status FROM orders').get().status, 'PENDING');
  const duplicateProduct = await worker.fetch(request('/api/products/p_test/purchase', { method: 'POST', body: { idempotency_key: 'another-order' } }), env);
  assert.equal(duplicateProduct.status, 409);
  assert.equal((await duplicateProduct.json()).error_code, 'ORDER_ALREADY_PENDING');
  assert.equal((await purchase()).status, 202);
  assert.equal(consumes, 1); assert.equal(queries, 1);
  resolution = 'SUCCEEDED';
  const sync = await worker.fetch(request('/api/orders/sync', { method: 'POST', body: {} }), env);
  assert.equal((await sync.json()).synced, 1);
  assert.equal(DB.raw.prepare('SELECT status FROM orders').get().status, 'DELIVERED');
  assert.equal(await bonusBalance(env, 'usr_user'), 0);
  assert.equal(consumes, 1); assert.equal(queries, 2);
});

sqliteTest('unknown upstream failure is refunded only after authoritative FAILED', async t => {
  const DB = await makeDb(), env = { DB, YIRENFU_API_KEY: 'fake-key' };
  await adjustBonus(env, { userId: 'usr_user', actorId: 'usr_admin', delta: 3, reason: '测试', key: 'grant-pending' });
  const oldFetch = globalThis.fetch; t.after(() => { globalThis.fetch = oldFetch; DB.raw.close(); });
  let resolution = 'UNKNOWN', consumes = 0;
  globalThis.fetch = async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/capabilities')) return Response.json({ capabilities: { entitlement_query: true, consumption: true } });
    if (path.endsWith('/access')) return Response.json({ requires_consumption: true, access_granted: true, remaining: 100 });
    if (path.endsWith('/consume')) { consumes++; return Response.json({ status: 'PROCESSING' }); }
    if (path.endsWith('/consumption')) return Response.json({ status: resolution });
    throw new Error('unexpected endpoint ' + path);
  };
  const purchase = await worker.fetch(request('/api/products/p_test/purchase', { method: 'POST', body: { idempotency_key: 'pending-order' } }), env);
  assert.equal(purchase.status, 202);
  await worker.fetch(request('/api/orders/sync', { method: 'POST', body: {} }), env);
  assert.equal(await bonusBalance(env, 'usr_user'), 0); assert.equal(DB.raw.prepare('SELECT stock FROM products').get().stock, 1);
  resolution = 'FAILED';
  const sync = await worker.fetch(request('/api/orders/sync', { method: 'POST', body: {} }), env);
  assert.equal((await sync.json()).synced, 1);
  assert.equal(DB.raw.prepare('SELECT status FROM orders').get().status, 'FAILED');
  assert.equal(await bonusBalance(env, 'usr_user'), 3); assert.equal(DB.raw.prepare('SELECT stock FROM products').get().stock, 2);
  await worker.fetch(request('/api/orders/sync', { method: 'POST', body: {} }), env);
  assert.equal(await bonusBalance(env, 'usr_user'), 3); assert.equal(consumes, 1);
});

sqliteTest('concurrent requests never spend the same grant twice or reserve identical order twice', async () => {
  const DB = await makeDb(), env = { DB };
  DB.raw.exec('UPDATE products SET allow_repeat=1');
  await adjustBonus(env, { userId: 'usr_user', actorId: 'usr_admin', delta: 10, reason: '测试', key: 'grant-concurrent' });
  DB.raw.exec('UPDATE products SET stock=1');
  const purchase = key => worker.fetch(request('/api/products/p_test/purchase', { method: 'POST', body: { idempotency_key: key } }), env);
  const same = await Promise.all([purchase('same-order'), purchase('same-order'), purchase('same-order')]);
  assert.ok(same.every(response => [200,202].includes(response.status)), 'same id may return delivered or pending');
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1);
  assert.equal(DB.raw.prepare('SELECT stock FROM products').get().stock, 0);
  assert.equal(await bonusBalance(env, 'usr_user'), 0);
  DB.raw.exec('UPDATE products SET stock=2');
  await adjustBonus(env, { userId: 'usr_user', actorId: 'usr_admin', delta: 10, reason: '测试', key: 'grant-concurrent-2' });
  const different = await Promise.all([purchase('different-a'), purchase('different-b')]);
  assert.equal(different.filter(response => response.status === 200).length, 1);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS n FROM orders WHERE status='DELIVERED'").get().n, 2);
  assert.equal(DB.raw.prepare('SELECT stock FROM products').get().stock, 1);
  assert.equal(await bonusBalance(env, 'usr_user'), 0);
  DB.raw.close();
});

sqliteTest('legacy CREATED consumption jobs are queried rather than resubmitted', async t => {
  const DB = await makeDb(), env = { DB, YIRENFU_API_KEY: 'fake-key' };
  await reserveOrder(env, { productId: 'p_test', userId: 'usr_user', key: 'legacy-order', orderNo: 'OLD1' });
  DB.raw.prepare("INSERT INTO consumption_jobs(idempotency_key,user_id,amount,reason,status,response_json,created_at,updated_at) VALUES(?,?,10,'兑换 测试商品','CREATED','{}','2026-01-01','2026-01-01')").run('legacy-order','usr_user');
  const oldFetch = globalThis.fetch; t.after(() => { globalThis.fetch = oldFetch; DB.raw.close(); });
  let consumes = 0, resolution = 'UNKNOWN';
  globalThis.fetch = async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/consumption')) return Response.json({ status: resolution, confirmed: resolution === 'SUCCEEDED' });
    if (path.endsWith('/consume')) { consumes++; throw new Error('must not submit legacy jobs'); }
    throw new Error('unexpected endpoint ' + path);
  };
  await worker.fetch(request('/api/orders/sync', { method: 'POST', body: {} }), env);
  assert.equal(DB.raw.prepare('SELECT status FROM orders').get().status, 'PENDING');
  resolution = 'SUCCEEDED';
  await worker.fetch(request('/api/orders/sync', { method: 'POST', body: {} }), env);
  assert.equal(DB.raw.prepare('SELECT status FROM orders').get().status, 'DELIVERED');
  assert.equal(consumes, 0);
});

for (const staleAccessAllowed of [false, true]) {
  sqliteTest(`expired processing lease cannot ${staleAccessAllowed ? 'resubmit' : 'refund'} a newer in-flight order`, async t => {
    const DB = await makeDb(), env = { DB, YIRENFU_API_KEY: 'fake-key' };
    await adjustBonus(env, { userId: 'usr_user', actorId: 'usr_admin', delta: 4, reason: '测试', key: 'lease-grant' });
    const oldFetch = globalThis.fetch;
    let releaseFirst, firstStarted;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    const started = new Promise(resolve => { firstStarted = resolve; });
    t.after(() => { releaseFirst(); globalThis.fetch = oldFetch; DB.raw.close(); });
    let accesses = 0, consumes = 0;
    globalThis.fetch = async url => {
      const path = new URL(url).pathname;
      if (path.endsWith('/capabilities')) return Response.json({ capabilities: { entitlement_query: true, consumption: true } });
      if (path.endsWith('/access')) {
        accesses++;
        if (accesses === 1) { firstStarted(); await firstGate; return Response.json({ requires_consumption: true, access_granted: staleAccessAllowed, remaining: staleAccessAllowed ? 100 : 0 }); }
        return Response.json({ requires_consumption: true, access_granted: true, remaining: 100 });
      }
      if (path.endsWith('/consume')) { consumes++; return Response.json({ status: 'PROCESSING' }); }
      throw new Error('unexpected endpoint ' + path);
    };
    const first = worker.fetch(request('/api/products/p_test/purchase', { method: 'POST', body: { idempotency_key: 'lease-order' } }), env);
    await started;
    DB.raw.exec("UPDATE orders SET processing_until=0 WHERE idempotency_key='lease-order'");
    const sync = await worker.fetch(request('/api/orders/sync', { method: 'POST', body: {} }), env);
    assert.equal((await sync.json()).synced, 0);
    releaseFirst();
    assert.equal((await first).status, 202);
    assert.equal(consumes, 1);
    assert.equal(DB.raw.prepare('SELECT status FROM orders').get().status, 'PENDING');
    assert.equal(await bonusBalance(env, 'usr_user'), 0);
    assert.equal(DB.raw.prepare('SELECT stock FROM products').get().stock, 1);
  });
}

sqliteTest('users and products with pending orders cannot be destructively deleted', async () => {
  const DB = await makeDb(), env = { DB };
  await adjustBonus(env, { userId: 'usr_user', actorId: 'usr_admin', delta: 4, reason: '测试', key: 'delete-grant' });
  await reserveOrder(env, { productId: 'p_test', userId: 'usr_user', key: 'delete-order', orderNo: 'DEL1' });
  let result = await worker.fetch(request('/api/admin/users/usr_user', { admin: true, method: 'DELETE' }), env);
  assert.equal(result.status, 409);
  assert.equal((await result.json()).error_code, 'USER_HAS_PENDING_ORDERS');
  assert.ok(DB.raw.prepare("SELECT id FROM users WHERE id='usr_user'").get());
  assert.ok(DB.raw.prepare("SELECT token_hash FROM sessions WHERE user_id='usr_user'").get());
  result = await worker.fetch(request('/api/admin/products/p_test', { admin: true, method: 'DELETE' }), env);
  assert.equal(result.status, 200); assert.equal((await result.json()).hidden, true);
  assert.equal(DB.raw.prepare('SELECT status FROM products').get().status, 'HIDDEN');
  DB.raw.exec("UPDATE orders SET processing_token='test' WHERE idempotency_key='delete-order'");
  assert.equal(await refundOrder(env, 'delete-order', 'test'), true);
  result = await worker.fetch(request('/api/admin/users/usr_user', { admin: true, method: 'DELETE' }), env);
  assert.equal(result.status, 200);
  assert.equal(DB.raw.prepare("SELECT id FROM users WHERE id='usr_user'").get(), undefined);
  assert.ok(DB.raw.prepare("SELECT COUNT(*) AS n FROM bonus_ledger WHERE user_id='usr_user'").get().n > 0);
  assert.equal((await adjustBonus(env, { userId: 'usr_user', actorId: 'usr_admin', delta: 1, reason: '测试', key: 'after-delete' })).ok, false);
  DB.raw.close();
});


sqliteTest('adjustment bounds include outstanding bonus reservations so a refund remains possible', async () => {
  const DB = await makeDb(), env = { DB };
  await adjustBonus(env, { userId: 'usr_user', actorId: 'usr_admin', delta: 1_000_000_000, reason: '测试上限', key: 'max-grant' });
  await reserveOrder(env, { productId: 'p_test', userId: 'usr_user', key: 'max-order', orderNo: 'MAX1' });
  assert.equal(await bonusBalance(env, 'usr_user'), 999_999_990);
  assert.equal((await adjustBonus(env, { userId: 'usr_user', actorId: 'usr_admin', delta: 10, reason: '测试', key: 'max-over' })).code, 'BALANCE_LIMIT');
  DB.raw.exec("UPDATE orders SET processing_token='test' WHERE idempotency_key='max-order'");
  assert.equal(await refundOrder(env, 'max-order', 'test'), true);
  assert.equal(await bonusBalance(env, 'usr_user'), 1_000_000_000);
  DB.raw.close();
});

class FakeBucket {
  objects = new Map();
  async put(key, data, options = {}) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.objects.set(key, { bytes, ...options });
  }
  async head(key) {
    const object = this.objects.get(key);
    return object ? { size: object.bytes.length, customMetadata: object.customMetadata } : null;
  }
  async get(key) {
    const object = this.objects.get(key);
    return object ? { size: object.bytes.length, body: new Response(object.bytes).body } : null;
  }
}

sqliteTest('reviewed directory and platform tags are public but delivery credentials never are', async t => {
  const DB = await makeDb(), env = { DB };
  t.after(() => DB.raw.close());
  const body = { title: '资料合集', price_points: 12, delivery_type: 'LINK', delivery_url: 'https://pan.quark.cn/s/paidSecret?pwd=ABC9', tags: '设计,教程', preview_files: '合集/\n合集/课程.mp4', preview_source: 'quark', preview_truncated: true };
  const created = await worker.fetch(request('/api/admin/products', { admin: true, method: 'POST', body }), env);
  assert.equal(created.status, 201); const pid = (await created.json()).product.id;
  let publicResponse = await worker.fetch(request('/api/products?tag=设计&tag=夸克网盘'), env);
  assert.equal(publicResponse.status, 200);
  let json = await publicResponse.json();
  assert.equal(json.items.length, 1);
  assert.deepEqual(json.items[0].tags, ['夸克网盘', '设计', '教程']);
  assert.deepEqual(json.items[0].preview_files, ['合集/', '合集/课程.mp4']);
  assert.equal(json.items[0].provider.id, 'quark'); assert.equal(json.items[0].preview_truncated, true);
  for (const secret of ['paidSecret', 'ABC9', 'delivery_url', 'file_key']) assert.equal(JSON.stringify(json).includes(secret), false);
  const noMatch = await worker.fetch(request('/api/products?tag=教程&tag=不存在'), env);
  assert.deepEqual((await noMatch.json()).items, []);
  const bad = await worker.fetch(request('/api/admin/products', { admin: true, method: 'POST', body: { ...body, preview_files: '提取码: ABC9' } }), env);
  assert.equal(bad.status, 400);
  const blocked = await worker.fetch(request('/api/admin/netdisk/preview', { method: 'POST', body: { url: body.delivery_url } }), env);
  assert.equal(blocked.status, 401);
  const before = DB.raw.prepare('SELECT preview_updated_at FROM products WHERE id=?').get(pid).preview_updated_at;
  const updated = await worker.fetch(request('/api/admin/products/' + pid, { admin: true, method: 'PUT', body: { ...body, status: 'HIDDEN', preview_files: ['合集/', '合集/课程.mp4'] } }), env);
  assert.equal(updated.status, 200);
  assert.equal(DB.raw.prepare('SELECT preview_updated_at FROM products WHERE id=?').get(pid).preview_updated_at, before);
  // Old clients omit snapshot data; changing the share must not retain old names.
  const { preview_files, preview_source, preview_truncated, ...oldClient } = body;
  const changed = await worker.fetch(request('/api/admin/products/' + pid, { admin: true, method: 'PUT', body: { ...oldClient, delivery_url: 'https://pan.baidu.com/s/1newPrivate' } }), env);
  assert.equal(changed.status, 200);
  publicResponse = await worker.fetch(request('/api/products?tag=百度网盘'), env);
  json = await publicResponse.json();
  assert.equal(json.items[0].provider.id, 'baidu'); assert.deepEqual(json.items[0].preview_files, []);
  assert.ok(!json.items[0].tags.includes('夸克网盘'));
  // Switching delivery type must not leave an old netdisk snapshot publicly visible.
  const switched = await worker.fetch(request('/api/admin/products/' + pid, { admin: true, method: 'PUT', body: { ...body, delivery_type: 'TEXT', delivery_text: '私密交付文本' } }), env);
  assert.equal(switched.status, 200);
  const textProduct = (await (await worker.fetch(request('/api/products'), env)).json()).items.find(p => p.id === pid);
  assert.deepEqual(textProduct.preview_files, []); assert.equal(textProduct.provider, null);
});

sqliteTest('agent tokens can only upload files and create idempotent hidden drafts', async t => {
  const DB = await makeDb(), BUCKET = new FakeBucket(), secret = '0123456789abcdef0123456789abcdef';
  const env = { DB, BUCKET, AGENT_API_TOKEN: secret }; t.after(() => DB.raw.close());
  const agentRequest = (path, body, token = secret) => new Request('https://example.test' + path, {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await worker.fetch(agentRequest('/api/agent/drafts', {}, 'bad'), env)).status, 401);
  assert.equal((await worker.fetch(agentRequest('/api/agent/drafts', {}), { DB, BUCKET })).status, 401);
  assert.equal((await worker.fetch(agentRequest('/api/admin/products', {}), env)).status, 401);
  const form = new FormData(); form.append('file', new Blob(['hello file'], { type: 'text/plain' }), '课程.txt');
  const uploaded = await worker.fetch(new Request('https://example.test/api/agent/uploads', { method: 'POST', headers: { authorization: 'Bearer ' + secret }, body: form }), env);
  assert.equal(uploaded.status, 200); const file = await uploaded.json();
  assert.match(file.key, /^agent\//); assert.equal(file.size, 10);
  const payload = { idempotency_key: 'agent-job-001', title: 'Agent 创作', price_points: 20, file_key: file.key, file_name: file.name, tags: ['模板'], status: 'ACTIVE' };
  const [first, second] = await Promise.all([
    worker.fetch(agentRequest('/api/agent/drafts', payload), env),
    worker.fetch(agentRequest('/api/agent/drafts', payload), env),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 201]);
  const [a, b] = await Promise.all([first.json(), second.json()]);
  assert.equal(a.product.id, b.product.id); assert.equal(a.product.status, 'HIDDEN');
  assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM products WHERE title='Agent 创作'").get().n, 1);
  assert.equal((await worker.fetch(agentRequest('/api/agent/drafts', { ...payload, title: '不同内容' }), env)).status, 409);
  assert.equal((await worker.fetch(agentRequest('/api/agent/drafts', { ...payload, idempotency_key: 'agent-job-002', file_key: 'goods/private.zip' }), env)).status, 400);
  const publicJson = await (await worker.fetch(request('/api/products'), env)).text();
  assert.equal(publicJson.includes('Agent 创作'), false); assert.equal(publicJson.includes(file.key), false);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='agent.draft_created'").get().n, 1);
  DB.raw.prepare('DELETE FROM products WHERE id=?').run(a.product.id);
  assert.equal((await worker.fetch(agentRequest('/api/agent/drafts', payload), env)).status, 410);
});

sqliteTest('AI covers require an admin, use the explicit model and only expose generated images', async t => {
  const DB = await makeDb(), BUCKET = new FakeBucket(); t.after(() => DB.raw.close());
  let calls = 0, args;
  const env = { DB, BUCKET, AI: { async run(...values) { calls++; args = values; return { image: btoa('\xff\xd8\xff\xe0test') }; } } };
  const body = { prompt: 'a lilac digital goods cover' };
  assert.equal((await worker.fetch(request('/api/admin/covers/generate', { method: 'POST', body }), env)).status, 401);
  assert.equal(calls, 0);
  const generated = await worker.fetch(request('/api/admin/covers/generate', { admin: true, method: 'POST', body }), env);
  assert.equal(generated.status, 201); const result = await generated.json();
  assert.equal(calls, 1); assert.equal(args[0], '@cf/black-forest-labs/flux-1-schnell'); assert.equal(args[1].steps, 4);
  const image = await worker.fetch(request(result.url), env);
  assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/jpeg');
  assert.match(image.headers.get('cache-control'), /immutable/);
  assert.equal((await image.arrayBuffer()).byteLength, 8);
  assert.equal((await worker.fetch(request('/api/covers/../../goods/private'), env)).status, 404);
  assert.equal((await worker.fetch(request('/api/admin/covers/generate', { admin: true, method: 'POST', body }), { DB, BUCKET })).status, 503);
  const audit = DB.raw.prepare("SELECT detail FROM admin_audit WHERE action='goods.cover_generated'").get();
  assert.equal(String(audit.detail).includes(body.prompt), false);
});

sqliteTest('admin directory diagnostics are private, authenticated and contain no share secrets', async t => {
  const DB = await makeDb(), env = { DB }, oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; DB.raw.close(); });
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls++;
    return new Response(JSON.stringify({ code: 31001, message: 'privateId A1b2 my-secret' }), { status: 403 });
  };
  const body = { url: 'https://pan.quark.cn/s/privateId?pwd=A1b2' };
  const blocked = await worker.fetch(request('/api/admin/netdisk/preview', { method: 'POST', body }), env);
  assert.equal(blocked.status, 401);
  assert.equal(upstreamCalls, 0);
  const result = await worker.fetch(request('/api/admin/netdisk/preview', { admin: true, method: 'POST', body }), env);
  assert.equal(result.status, 422);
  assert.equal(result.headers.get('cache-control'), 'private, no-store');
  const json = await result.json();
  assert.equal(json.error_code, 'NETDISK_PREVIEW_UNAVAILABLE');
  assert.deepEqual(json.diagnostic, { provider: 'quark', stage: 'TOKEN', reason: 'HTTP_ERROR', http_status: 403, provider_code: 31001 });
  assert.equal(upstreamCalls, 4); // two Skill guest hosts and two legacy token hosts
  for (const secret of ['privateId', 'A1b2', 'my-secret']) assert.ok(!JSON.stringify(json).includes(secret));
});

sqliteTest('admin preview consumes a mocked Skill-style root and child without leaking upstream identifiers', async t => {
  const DB = await makeDb(), env = { DB }, oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; DB.raw.close(); });
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(url); calls.push(parsed.pathname);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.cookie, undefined);
    if (parsed.pathname.endsWith('/v2/detail')) {
      assert.equal(JSON.parse(options.body).passcode, 'A1b2');
      return new Response(JSON.stringify({ status: 200, code: 0, data: { token_info: { stoken: 'temporary-stoken' }, detail_info: { list: [{ file_name: '目录', fid: 'hidden-folder', file_type: 0 }] } } }));
    }
    assert.equal(parsed.searchParams.get('pdir_fid'), 'hidden-folder');
    return new Response(JSON.stringify({ status: 200, code: 0, data: { list: [{ file_name: '文件.pdf', fid: 'hidden-file', file_type: 1 }] } }));
  };
  const result = await worker.fetch(request('/api/admin/netdisk/preview', {
    admin: true, method: 'POST', body: { url: 'https://pan.quark.cn/s/privateId?pwd=A1b2' },
  }), env);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'private, no-store');
  const json = await result.json();
  assert.deepEqual(json.items, ['目录/', '目录/文件.pdf']);
  assert.equal(json.truncated, false);
  assert.equal(calls.length, 2);
  for (const secret of ['privateId', 'A1b2', 'temporary-stoken', 'hidden-folder', 'hidden-file']) assert.ok(!JSON.stringify(json).includes(secret));
});

sqliteTest('an administrator cannot disable their own account or invalidate any of their sessions', async t => {
  const DB = await makeDb(), env = { DB };
  t.after(() => DB.raw.close());
  for (const [token, role] of [['second-admin-token', 'admin'], ['admin-user-token', 'user']]) {
    DB.raw.prepare('INSERT INTO sessions(token_hash,user_id,role,expires_at,created_at) VALUES(?,?,?,?,?)')
      .run(createHash('sha256').update(token).digest('base64url'), 'usr_admin', role, 9999999999, '2026-01-01');
  }
  DB.raw.prepare("UPDATE users SET updated_at='before-attempt' WHERE id='usr_admin'").run();
  const beforeUser = DB.raw.prepare("SELECT disabled,updated_at FROM users WHERE id='usr_admin'").get();
  const beforeSessions = DB.raw.prepare("SELECT token_hash,role FROM sessions WHERE user_id='usr_admin' ORDER BY token_hash").all();
  const beforeAudit = DB.raw.prepare('SELECT COUNT(*) AS n FROM admin_audit').get().n;

  for (const token of ['admin-token', 'second-admin-token']) {
    const res = await worker.fetch(new Request('https://example.test/api/admin/users/usr_admin/status', {
      method: 'POST',
      headers: { cookie: `onepay_admin_session=${token}`, 'content-type': 'application/json' },
      // A caller-supplied identity must not influence which account is protected.
      body: JSON.stringify({ disabled: true, current_user_id: 'usr_user' }),
    }), env);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: '不能停用当前登录的管理员账号', error_code: 'SELF_DISABLE_FORBIDDEN' });
  }
  assert.deepEqual(DB.raw.prepare("SELECT disabled,updated_at FROM users WHERE id='usr_admin'").get(), beforeUser);
  assert.deepEqual(DB.raw.prepare("SELECT token_hash,role FROM sessions WHERE user_id='usr_admin' ORDER BY token_hash").all(), beforeSessions);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM admin_audit').get().n, beforeAudit);

  const me = await worker.fetch(request('/api/admin/me', { admin: true }), env);
  assert.equal((await me.json()).authenticated, true);
  const frontMe = await worker.fetch(new Request('https://example.test/api/auth/me', { headers: { cookie: 'onepay_session=admin-user-token' } }), env);
  assert.equal((await frontMe.json()).authenticated, true);

  // An idempotent enable is not a disable and must not revoke sessions either.
  const enable = await worker.fetch(request('/api/admin/users/usr_admin/status', { admin: true, method: 'POST', body: { disabled: false } }), env);
  assert.equal(enable.status, 200);
  assert.equal((await enable.json()).disabled, false);
  assert.deepEqual(DB.raw.prepare("SELECT token_hash,role FROM sessions WHERE user_id='usr_admin' ORDER BY token_hash").all(), beforeSessions);
});

sqliteTest('administrators can still disable and enable other users and administrators', async t => {
  const DB = await makeDb(), env = { DB };
  t.after(() => DB.raw.close());
  DB.raw.exec("INSERT INTO users(id,email,password_hash,created_at,role) VALUES('usr_other_admin','other-admin@example.com','x','2026-01-02','admin')");
  DB.raw.prepare('INSERT INTO sessions(token_hash,user_id,role,expires_at,created_at) VALUES(?,?,?,?,?)')
    .run(createHash('sha256').update('other-admin-token').digest('base64url'), 'usr_other_admin', 'admin', 9999999999, '2026-01-01');
  const otherList = await worker.fetch(new Request('https://example.test/api/admin/users', { headers: { cookie: 'onepay_admin_session=other-admin-token' } }), env);
  assert.equal((await otherList.json()).current_user_id, 'usr_other_admin');
  const otherSelf = await worker.fetch(new Request('https://example.test/api/admin/users/usr_other_admin/status', {
    method: 'POST', headers: { cookie: 'onepay_admin_session=other-admin-token', 'content-type': 'application/json' }, body: JSON.stringify({ disabled: true }),
  }), env);
  assert.equal(otherSelf.status, 400);
  assert.equal((await otherSelf.json()).error_code, 'SELF_DISABLE_FORBIDDEN');
  const list = await worker.fetch(request('/api/admin/users?q=user%40example.com', { admin: true }), env);
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('cache-control'), 'private, no-store');
  const data = await list.json();
  assert.equal(data.current_user_id, 'usr_admin'); // Present even when the current account is filtered out.
  assert.deepEqual(data.items.map(u => u.id), ['usr_user']);
  const unauthenticated = await worker.fetch(request('/api/admin/users/usr_admin/status', { method: 'POST', body: { disabled: true } }), env);
  assert.equal(unauthenticated.status, 401);

  for (const target of ['usr_user', 'usr_other_admin']) {
    const disabled = await worker.fetch(request(`/api/admin/users/${target}/status`, { admin: true, method: 'POST', body: { disabled: true } }), env);
    assert.equal(disabled.status, 200);
    assert.equal((await disabled.json()).disabled, true);
    assert.equal(DB.raw.prepare('SELECT disabled FROM users WHERE id=?').get(target).disabled, 1);
    assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?').get(target).n, 0);
    assert.equal(DB.raw.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action='user.disabled' AND target=?").get(target).n, 1);

    const enabled = await worker.fetch(request(`/api/admin/users/${target}/status`, { admin: true, method: 'POST', body: { disabled: false } }), env);
    assert.equal(enabled.status, 200);
    assert.equal((await enabled.json()).disabled, false);
    assert.equal(DB.raw.prepare('SELECT disabled FROM users WHERE id=?').get(target).disabled, 0);
    assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?').get(target).n, 0);
    assert.equal(DB.raw.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action='user.enabled' AND target=?").get(target).n, 1);
  }
  assert.equal((await (await worker.fetch(request('/api/admin/me', { admin: true }), env)).json()).authenticated, true);
  assert.equal((await (await worker.fetch(request('/api/auth/me'), env)).json()).authenticated, false);
});

sqliteTest('non-repeatable goods block new purchases atomically while same-key retries remain idempotent', async t => {
  const DB = await makeDb(), env = { DB };
  t.after(() => DB.raw.close());
  assert.equal(DB.raw.prepare("SELECT allow_repeat FROM products WHERE id='p_test'").get().allow_repeat, 0);
  await adjustBonus(env, { userId: 'usr_user', actorId: 'usr_admin', delta: 40, reason: '测试', key: 'repeat-grant' });
  const purchase = key => worker.fetch(request('/api/products/p_test/purchase', { method: 'POST', body: { idempotency_key: key, expected_price: 10, expected_kind: 'SINGLE', expected_days: 0 } }), env);
  const concurrent = await Promise.all([purchase('no-repeat-a'), purchase('no-repeat-b')]);
  assert.equal(concurrent.filter(r => r.status === 200).length, 1);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM orders WHERE status='DELIVERED'").get().n, 1);
  assert.equal(await bonusBalance(env, 'usr_user'), 30);
  assert.equal(DB.raw.prepare('SELECT stock FROM products WHERE id=?').get('p_test').stock, 1);
  const firstKey = DB.raw.prepare('SELECT idempotency_key FROM orders').get().idempotency_key;
  const retry = await purchase(firstKey); assert.equal(retry.status, 200); assert.equal((await retry.json()).already_delivered, true);
  const blocked = await purchase('no-repeat-c'); assert.equal(blocked.status, 409); assert.equal((await blocked.json()).error_code, 'ALREADY_PURCHASED');
  assert.equal(await bonusBalance(env, 'usr_user'), 30);
  const library = await worker.fetch(request('/api/library'), env);
  assert.equal(library.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual((await library.json()).owned_product_ids, ['p_test']);
  const adminProduct = (await (await worker.fetch(request('/api/admin/products', { admin: true }), env)).json()).items[0];
  const edit = await worker.fetch(request('/api/admin/products/p_test', { admin: true, method: 'PUT', body: { ...adminProduct, allow_repeat: true } }), env);
  assert.equal(edit.status, 200);
  assert.equal((await purchase('repeat-allowed')).status, 200);
  assert.equal(await bonusBalance(env, 'usr_user'), 20);
});

sqliteTest('displayed price and subscription terms cannot change before reservation', async t => {
  const DB = await makeDb(), env = { DB };
  t.after(() => DB.raw.close());
  await adjustBonus(env, { userId: 'usr_user', actorId: 'usr_admin', delta: 20, reason: '测试', key: 'terms-grant' });
  const result = await worker.fetch(request('/api/products/p_test/purchase', { method: 'POST', body: { idempotency_key: 'terms-test', expected_price: 9, expected_kind: 'SINGLE', expected_days: 0 } }), env);
  assert.equal(result.status, 409); assert.equal((await result.json()).error_code, 'PRODUCT_TERMS_CHANGED');
  assert.equal(DB.raw.prepare('SELECT COUNT(*) n FROM orders').get().n, 0);
  assert.equal(await bonusBalance(env, 'usr_user'), 20);
  assert.equal(DB.raw.prepare('SELECT stock FROM products').get().stock, 2);
  for (const terms of [{ expected_kind: 'SUBSCRIPTION' }, { expected_days: 7 }]) {
    const response = await worker.fetch(request('/api/products/p_test/purchase', { method: 'POST', body: { idempotency_key: 'term-' + Object.keys(terms)[0], ...terms } }), env);
    assert.equal(response.status, 409); assert.equal((await response.json()).error_code, 'PRODUCT_TERMS_CHANGED');
  }
  assert.equal(await bonusBalance(env, 'usr_user'), 20);
});

sqliteTest('timed subscriptions grant and extend once, protect updates, and expire until manual renewal', async t => {
  const DB = await makeDb(), BUCKET = new FakeBucket(), env = { DB, BUCKET };
  t.after(() => DB.raw.close());
  await BUCKET.put('goods/test/private.pdf', new TextEncoder().encode('private file'), {});
  const create = await worker.fetch(request('/api/admin/products', { admin: true, method: 'POST', body: { title: '每周系列', price_points: 10, product_kind: 'SUBSCRIPTION', subscription_days: 7, update_frequency: 'WEEKLY', preview_files: '第一期/\n第一期/公开文件名.pdf', stock: null, status: 'ACTIVE' } }), env);
  assert.equal(create.status, 201);
  const product = (await create.json()).product, pid = product.id;
  const updatePath = `/api/admin/products/${pid}/updates`;
  const createUpdate = body => worker.fetch(request(updatePath, { admin: true, method: 'POST', body }), env);
  const text = await createUpdate({ title: '第一期', delivery_type: 'TEXT', delivery_text: 'private-text-content' });
  assert.equal(text.status, 201);
  const file = await createUpdate({ title: '第二期', delivery_type: 'FILE', file_key: 'goods/test/private.pdf', file_name: '资料.pdf' });
  assert.equal(file.status, 201); const fid = (await file.json()).update.id;
  assert.equal((await createUpdate({ title: '草稿', delivery_type: 'LINK', delivery_url: 'https://example.test/private-url', status: 'HIDDEN' })).status, 201);
  const hiddenFile = await createUpdate({ title: '隐藏文件', delivery_type: 'FILE', file_key: 'goods/test/private.pdf', status: 'HIDDEN' });
  const hiddenId = (await hiddenFile.json()).update.id;
  assert.equal((await createUpdate({ title: '不存在的文件', delivery_type: 'FILE', file_key: 'goods/not-there' })).status, 404);
  assert.equal((await worker.fetch(request(updatePath), env)).status, 401);
  assert.equal((await worker.fetch(request(`/api/subscriptions/${pid}/updates`), env)).status, 404);
  const publicText = await (await worker.fetch(request('/api/products'), env)).text();
  assert.ok(publicText.includes('公开文件名.pdf'));
  for (const secret of ['private-text-content', 'private-url', 'goods/test/private.pdf']) assert.equal(publicText.includes(secret), false);

  await adjustBonus(env, { userId: 'usr_user', actorId: 'usr_admin', delta: 40, reason: '测试', key: 'sub-grant' });
  const buy = (key, revision) => worker.fetch(request(`/api/products/${pid}/purchase`, { method: 'POST', body: { idempotency_key: key, expected_price: 10, expected_kind: 'SUBSCRIPTION', expected_days: 7, subscription_revision: revision } }), env);
  const first = await buy('sub-one', 'none'); assert.equal(first.status, 200); assert.equal((await first.json()).delivery.type, 'SUBSCRIPTION');
  const firstSub = DB.raw.prepare('SELECT * FROM subscriptions WHERE user_id=? AND product_id=?').get('usr_user', pid);
  assert.equal(firstSub.permanent, 0);
  assert.ok(firstSub.expires_at >= Math.floor(Date.now() / 1000) + 7 * 86400 - 2);
  const retry = await buy('sub-one', 'none'); assert.equal(retry.status, 200); assert.equal((await retry.json()).already_delivered, true);
  assert.equal(DB.raw.prepare('SELECT expires_at FROM subscriptions WHERE user_id=? AND product_id=?').get('usr_user', pid).expires_at, firstSub.expires_at);
  const stale = await buy('sub-stale', 'none'); assert.equal(stale.status, 409); assert.equal((await stale.json()).error_code, 'SUBSCRIPTION_CHANGED');
  assert.equal(await bonusBalance(env, 'usr_user'), 30);
  const updateResponse = await worker.fetch(request(`/api/subscriptions/${pid}/updates`), env);
  assert.equal(updateResponse.status, 200); assert.equal(updateResponse.headers.get('cache-control'), 'private, no-store');
  const updates = await updateResponse.json(); assert.equal(updates.items.length, 2);
  assert.ok(updates.items.some(u => u.delivery.text === 'private-text-content'));
  assert.ok(!JSON.stringify(updates).includes('goods/test/private.pdf'));
  assert.ok(!JSON.stringify(updates).includes('private-url'));
  const download = await worker.fetch(request(`/api/subscriptions/${pid}/updates/${fid}/file`), env);
  assert.equal(download.status, 200); assert.equal(await download.text(), 'private file');
  assert.match(download.headers.get('content-disposition'), /attachment/);
  assert.equal((await worker.fetch(request(`/api/subscriptions/${pid}/updates/${hiddenId}/file`), env)).status, 404);
  DB.raw.exec("INSERT INTO users(id,email,password_hash,created_at,role) VALUES('usr_other','other@example.com','x','2026-01-01','user')");
  DB.raw.prepare('INSERT INTO sessions(token_hash,user_id,role,expires_at,created_at) VALUES(?,?,?,?,?)').run(createHash('sha256').update('other-token').digest('base64url'), 'usr_other', 'user', 9999999999, '2026-01-01');
  const other = path => new Request('https://example.test' + path, { headers: { cookie: 'onepay_session=other-token' } });
  assert.equal((await worker.fetch(other(`/api/subscriptions/${pid}/updates`), env)).status, 404);
  assert.equal((await worker.fetch(other(`/api/subscriptions/${pid}/updates/${fid}/file`), env)).status, 404);
  assert.equal((await worker.fetch(new Request(`https://example.test/api/subscriptions/${pid}/updates`), env)).status, 401);

  assert.equal((await buy('sub-renew', `until:${firstSub.expires_at}`)).status, 200);
  assert.equal(DB.raw.prepare('SELECT expires_at FROM subscriptions WHERE user_id=? AND product_id=?').get('usr_user', pid).expires_at, firstSub.expires_at + 7 * 86400);
  assert.equal(await bonusBalance(env, 'usr_user'), 20);
  DB.raw.prepare('UPDATE subscriptions SET expires_at=? WHERE user_id=? AND product_id=?').run(Math.floor(Date.now() / 1000) - 1, 'usr_user', pid);
  assert.equal((await worker.fetch(request(`/api/subscriptions/${pid}/updates`), env)).status, 403);
  assert.equal((await worker.fetch(request(`/api/subscriptions/${pid}/updates/${fid}/file`), env)).status, 403);
  assert.equal((await (await worker.fetch(request('/api/subscriptions'), env)).json()).items[0].active, false);
  const expiredRevision = `until:${DB.raw.prepare('SELECT expires_at FROM subscriptions WHERE user_id=? AND product_id=?').get('usr_user', pid).expires_at}`;
  assert.equal((await buy('sub-after-expiry', expiredRevision)).status, 200);
  assert.equal((await worker.fetch(request(`/api/subscriptions/${pid}/updates`), env)).status, 200);
  assert.ok(DB.raw.prepare('SELECT expires_at FROM subscriptions WHERE user_id=? AND product_id=?').get('usr_user', pid).expires_at >= Math.floor(Date.now() / 1000) + 7 * 86400 - 2);

  const changingKind = await worker.fetch(request(`/api/admin/products/${pid}`, { admin: true, method: 'PUT', body: { ...product, product_kind: 'SINGLE', delivery_type: 'TEXT', delivery_text: 'x' } }), env);
  assert.equal(changingKind.status, 409); assert.equal((await changingKind.json()).error_code, 'PRODUCT_KIND_LOCKED');
  assert.equal((await worker.fetch(request('/api/admin/users/usr_user', { admin: true, method: 'DELETE' }), env)).status, 200);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) n FROM subscriptions WHERE user_id=?').get('usr_user').n, 0);
});

sqliteTest('permanent subscriptions cannot be bought twice and do not expire after product term edits', async t => {
  const DB = await makeDb(), env = { DB };
  t.after(() => DB.raw.close());
  const create = await worker.fetch(request('/api/admin/products', { admin: true, method: 'POST', body: { title: '永久系列', price_points: 10, product_kind: 'SUBSCRIPTION', subscription_days: 0, update_frequency: 'DAILY', stock: null, status: 'ACTIVE' } }), env);
  assert.equal(create.status, 201); const p = (await create.json()).product;
  await adjustBonus(env, { userId: 'usr_user', actorId: 'usr_admin', delta: 20, reason: '测试', key: 'permanent-grant' });
  const buy = (key, days = 0, revision = 'none') => worker.fetch(request(`/api/products/${p.id}/purchase`, { method: 'POST', body: { idempotency_key: key, expected_price: 10, expected_kind: 'SUBSCRIPTION', expected_days: days, subscription_revision: revision } }), env);
  assert.equal((await buy('permanent-one')).status, 200);
  const sub = DB.raw.prepare('SELECT * FROM subscriptions WHERE user_id=? AND product_id=?').get('usr_user', p.id);
  assert.equal(sub.permanent, 1); assert.equal(sub.expires_at, null);
  const edit = await worker.fetch(request(`/api/admin/products/${p.id}`, { admin: true, method: 'PUT', body: { ...p, subscription_days: 30, allow_repeat: 1 } }), env);
  assert.equal(edit.status, 200);
  const duplicate = await buy('permanent-two', 30, 'permanent'); assert.equal(duplicate.status, 409); assert.equal((await duplicate.json()).error_code, 'ALREADY_SUBSCRIBED');
  assert.equal(await bonusBalance(env, 'usr_user'), 10);
  assert.equal(DB.raw.prepare('SELECT permanent FROM subscriptions WHERE user_id=? AND product_id=?').get('usr_user', p.id).permanent, 1);
});

sqliteTest('subscription entitlement is granted only after an ambiguous upstream debit is confirmed', async t => {
  const DB = await makeDb(), env = { DB, YIRENFU_API_KEY: 'fake-key' };
  const oldFetch = globalThis.fetch; t.after(() => { globalThis.fetch = oldFetch; DB.raw.close(); });
  DB.raw.exec("UPDATE products SET product_kind='SUBSCRIPTION',subscription_days=30,stock=NULL WHERE id='p_test'");
  let confirmed = false, consumes = 0;
  globalThis.fetch = async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/capabilities')) return Response.json({ capabilities: { entitlement_query: true, consumption: true } });
    if (path.endsWith('/access')) return Response.json({ requires_consumption: true, access_granted: true, remaining: 100 });
    if (path.endsWith('/consume')) { consumes++; return Response.json({ status: 'PROCESSING' }); }
    if (path.endsWith('/consumption')) return Response.json(confirmed ? { status: 'SUCCEEDED', confirmed: true } : { status: 'PROCESSING' });
    throw new Error('unexpected endpoint');
  };
  const buy = () => worker.fetch(request('/api/products/p_test/purchase', { method: 'POST', body: { idempotency_key: 'sub-unknown', expected_price: 10, expected_kind: 'SUBSCRIPTION', expected_days: 30, subscription_revision: 'none' } }), env);
  assert.equal((await buy()).status, 202);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) n FROM subscriptions').get().n, 0);
  assert.equal((await buy()).status, 202); assert.equal(consumes, 1);
  const legacyRetry = await worker.fetch(request('/api/products/p_test/purchase', { method: 'POST', body: { idempotency_key: 'sub-unknown' } }), env);
  assert.equal(legacyRetry.status, 202); assert.equal(consumes, 1);
  const differentKey = await worker.fetch(request('/api/products/p_test/purchase', { method: 'POST', body: { idempotency_key: 'sub-unknown-other', expected_price: 10, expected_kind: 'SUBSCRIPTION', expected_days: 30, subscription_revision: 'none' } }), env);
  assert.equal(differentKey.status, 409); assert.equal((await differentKey.json()).error_code, 'ORDER_ALREADY_PENDING');
  assert.equal(DB.raw.prepare('SELECT COUNT(*) n FROM subscriptions').get().n, 0); assert.equal(consumes, 1);
  confirmed = true;
  const synced = await worker.fetch(request('/api/orders/sync', { method: 'POST', body: {} }), env);
  assert.equal((await synced.json()).synced, 1);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) n FROM subscriptions').get().n, 1);
  const expires = DB.raw.prepare('SELECT expires_at FROM subscriptions').get().expires_at;
  assert.equal((await buy()).status, 200);
  assert.equal(DB.raw.prepare('SELECT expires_at FROM subscriptions').get().expires_at, expires);
  assert.equal(consumes, 1);
});

sqliteTest('migration marks existing products as non-repeatable and historical orders as ordinary purchases', async t => {
  const DB = await makeDb({ beforeSubscriptionMigration: true }), env = { DB };
  t.after(() => DB.raw.close());
  DB.raw.exec(`INSERT INTO orders(idempotency_key,order_no,user_id,product_id,title,price_points,delivery_type,delivery_text,status,created_at,delivered_at)
    VALUES('legacy-order','NOOLD','usr_user','p_test','旧商品',10,'TEXT','旧内容','DELIVERED','2025-01-01','2025-01-01');`);
  DB.raw.exec(await readFile(new URL('../migrations/0008_subscriptions_and_repeat.sql', import.meta.url), 'utf8'));
  assert.equal(DB.raw.prepare("SELECT allow_repeat FROM products WHERE id='p_test'").get().allow_repeat, 0);
  assert.deepEqual({ ...DB.raw.prepare("SELECT product_kind,subscription_days FROM orders WHERE idempotency_key='legacy-order'").get() }, { product_kind: 'SINGLE', subscription_days: 0 });
  await adjustBonus(env, { userId: 'usr_user', actorId: 'usr_admin', delta: 20, reason: '测试', key: 'legacy-grant' });
  const response = await worker.fetch(request('/api/products/p_test/purchase', { method: 'POST', body: { idempotency_key: 'legacy-repeat' } }), env);
  assert.equal(response.status, 409); assert.equal((await response.json()).error_code, 'ALREADY_PURCHASED');
  assert.equal(await bonusBalance(env, 'usr_user'), 20);
});

sqliteTest('two concurrent subscription confirmations with the same quoted entitlement cannot both charge', async t => {
  const DB = await makeDb(), env = { DB }; t.after(() => DB.raw.close());
  DB.raw.exec("UPDATE products SET product_kind='SUBSCRIPTION',subscription_days=7,stock=NULL WHERE id='p_test'");
  await adjustBonus(env, { userId: 'usr_user', actorId: 'usr_admin', delta: 20, reason: '测试', key: 'parallel-sub-grant' });
  const unconfirmed = await worker.fetch(request('/api/products/p_test/purchase', { method: 'POST', body: { idempotency_key: 'missing-quote' } }), env);
  assert.equal(unconfirmed.status, 409); assert.equal((await unconfirmed.json()).error_code, 'SUBSCRIPTION_CONFIRMATION_REQUIRED');
  assert.equal(await bonusBalance(env, 'usr_user'), 20);
  const buy = key => worker.fetch(request('/api/products/p_test/purchase', { method: 'POST', body: {
    idempotency_key: key, expected_price: 10, expected_kind: 'SUBSCRIPTION', expected_days: 7, subscription_revision: 'none',
  } }), env);
  const responses = await Promise.all([buy('parallel-sub-a'), buy('parallel-sub-b')]);
  assert.equal(responses.filter(r => r.status === 200).length, 1);
  assert.equal(responses.filter(r => r.status === 409).length, 1);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) n FROM orders').get().n, 1);
  assert.equal(await bonusBalance(env, 'usr_user'), 10);
});

sqliteTest('private series updates page correctly and hidden entries are never included', async t => {
  const DB = await makeDb(), env = { DB }; t.after(() => DB.raw.close());
  DB.raw.exec("UPDATE products SET product_kind='SUBSCRIPTION',subscription_days=0,stock=NULL WHERE id='p_test'");
  await adjustBonus(env, { userId: 'usr_user', actorId: 'usr_admin', delta: 10, reason: '测试', key: 'paging-grant' });
  assert.equal((await worker.fetch(request('/api/products/p_test/purchase', { method: 'POST', body: { idempotency_key: 'paging-purchase', expected_price: 10, expected_kind: 'SUBSCRIPTION', expected_days: 0, subscription_revision: 'none' } }), env)).status, 200);
  const insert = DB.raw.prepare("INSERT INTO subscription_updates(id,product_id,title,delivery_type,delivery_text,status,created_at,updated_at) VALUES(?,? ,?,'TEXT',?,?,?,?)");
  for (let i = 0; i < 35; i++) insert.run(`upd_${String(i).padStart(2, '0')}`, 'p_test', `期数${i}`, `私密${i}`, i === 34 ? 'HIDDEN' : 'PUBLISHED', '2026-01-01', '2026-01-01');
  const first = await worker.fetch(request('/api/subscriptions/p_test/updates'), env);
  const one = await first.json(); assert.equal(first.headers.get('cache-control'), 'private, no-store');
  assert.equal(one.items.length, 30); assert.equal(one.has_more, true); assert.equal(one.next_offset, 30);
  const two = await (await worker.fetch(request('/api/subscriptions/p_test/updates?offset=30'), env)).json();
  assert.equal(two.items.length, 4); assert.equal(two.has_more, false);
  assert.equal(new Set([...one.items, ...two.items].map(x => x.id)).size, 34);
  assert.ok(!JSON.stringify([one, two]).includes('私密34'));
});

sqliteTest('admin Agent status checks token configuration without returning the token', async t => {
  const DB = await makeDb(), secret = 'preview-agent-secret-that-is-long-enough'; t.after(() => DB.raw.close());
  const status = async token => worker.fetch(request('/api/admin/status', { admin: true }), { DB, AGENT_API_TOKEN: token });
  const enabled = await status(secret); const text = await enabled.text();
  assert.equal(JSON.parse(text).agentConfigured, true); assert.equal(text.includes(secret), false);
  assert.equal((await (await status('short')).json()).agentConfigured, false);
  assert.equal((await (await status(secret + ' ')).json()).agentConfigured, false);
  assert.equal((await worker.fetch(request('/api/admin/status'), { DB, AGENT_API_TOKEN: secret })).status, 401);
});

sqliteTest('a user can page through their full purchase history without exposing other users orders', async t => {
  const DB = await makeDb(), env = { DB }; t.after(() => DB.raw.close());
  const insert = DB.raw.prepare("INSERT INTO orders(idempotency_key,order_no,user_id,product_id,title,price_points,delivery_type,delivery_text,status,created_at,delivered_at) VALUES(?,?,?,?,?,10,'TEXT',?,'DELIVERED',?,?)");
  for (let i = 0; i < 54; i++) insert.run(`page-${String(i).padStart(2, '0')}`, `NO${i}`, 'usr_user', 'p_test', '旧订单', `本人内容${i}`, '2026-01-01', '2026-01-01');
  insert.run('page-admin', 'NOADMIN', 'usr_admin', 'p_test', '他人订单', '不得泄露', '2026-01-01', '2026-01-01');
  const firstResponse = await worker.fetch(request('/api/orders?offset=0'), env), first = await firstResponse.json();
  assert.equal(first.items.length, 50); assert.equal(first.has_more, true); assert.equal(first.next_offset, 50);
  assert.equal(firstResponse.headers.get('cache-control'), 'private, no-store');
  const second = await (await worker.fetch(request('/api/orders?offset=50'), env)).json();
  assert.equal(second.items.length, 4); assert.equal(second.has_more, false);
  assert.equal(new Set([...first.items, ...second.items].map(order => order.key)).size, 54);
  assert.ok(!JSON.stringify([first, second]).includes('不得泄露'));
});

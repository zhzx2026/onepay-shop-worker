import test from 'node:test';
import assert from 'node:assert/strict';
import { cachedPublicJson, invalidatePublicCache, withStaticCache } from '../src/cache.js';
import worker from '../src/index.js';

class FakeCache {
  entries = new Map();
  operations = [];
  async match(request) {
    this.operations.push(['match', request.url]);
    return this.entries.get(request.url)?.clone();
  }
  async put(request, response) {
    this.operations.push(['put', request.url]);
    this.entries.set(request.url, response.clone());
  }
  async delete(request) {
    this.operations.push(['delete', request.url]);
    return this.entries.delete(request.url);
  }
}

function installCache(t, cache = new FakeCache()) {
  const original = globalThis.caches;
  globalThis.caches = { default: cache };
  t.after(() => {
    if (original === undefined) delete globalThis.caches;
    else globalThis.caches = original;
  });
  return cache;
}

function context() {
  const pending = [];
  return {
    waitUntil(promise) { pending.push(promise); },
    async flush() { await Promise.all(pending.splice(0)); },
  };
}

const request = (path, options) => new Request('https://shop.example' + path, options);
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' } });

async function read(path, produce, ctx = context(), options) {
  const response = await cachedPublicJson(request(path, options), produce, ctx);
  await ctx.flush();
  return response;
}

test('public data hits the edge cache and normalizes product filter variants', async t => {
  installCache(t);
  let calls = 0;
  const produce = async () => json({ calls: ++calls });
  const first = await read('/api/products?tag=设计&category=cat1&utm_source=a', produce);
  assert.equal(first.headers.get('x-cache'), 'MISS');
  assert.match(first.headers.get('cache-control'), /max-age=5, s-maxage=30/);
  const second = await read('/api/products?category=cat1&tag=设计&utm_source=b', produce);
  assert.equal(second.headers.get('x-cache'), 'HIT');
  assert.equal((await second.json()).calls, 1);
  const third = await read('/api/products?category=cat2&tag=设计', produce);
  assert.equal(third.headers.get('x-cache'), 'MISS');
  assert.equal(calls, 2);
});

test('rotating a catalog generation invalidates all local query variants without flushing site configuration', async t => {
  installCache(t);
  let revision = 1, calls = 0;
  const produce = async () => { calls++; return json({ revision }); };
  await read('/api/products', produce);
  await read('/api/products?category=cat1', produce);
  await read('/api/products?tag=设计', produce);
  await read('/api/categories', produce);
  await read('/api/config', produce);
  revision = 2;
  await invalidatePublicCache(request('/api/admin/products'), ['catalog']);
  for (const path of ['/api/products', '/api/products?category=cat1', '/api/products?tag=设计', '/api/categories']) {
    const response = await read(path, produce);
    assert.equal(response.headers.get('x-cache'), 'MISS', path);
    assert.equal((await response.json()).revision, 2);
  }
  const config = await read('/api/config', produce);
  assert.equal(config.headers.get('x-cache'), 'HIT');
  assert.equal((await config.json()).revision, 1);
  assert.equal(calls, 9);
});

test('a response written after invalidation cannot resurrect the old generation', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  class SlowCache extends FakeCache {
    async put(req, response) {
      if (req.url.includes('/api/products') && !this.delayed) {
        this.delayed = true;
        await gate;
      }
      return super.put(req, response);
    }
  }
  const cache = installCache(t, new SlowCache());
  const ctx = context();
  const stale = await cachedPublicJson(request('/api/products'), async () => json({ revision: 1 }), ctx);
  assert.equal(stale.headers.get('x-cache'), 'MISS');
  await Promise.resolve(); // Start the deferred cache write.
  await invalidatePublicCache(request('/api/admin/products'), ['catalog']);
  release();
  await ctx.flush();
  const fresh = await read('/api/products', async () => json({ revision: 2 }));
  assert.equal(fresh.headers.get('x-cache'), 'MISS');
  assert.equal((await fresh.json()).revision, 2);
  assert.ok(cache.delayed);
});

test('explicit refresh bypasses an edge hit; no-store never writes shared data', async t => {
  const cache = installCache(t);
  let revision = 1;
  const produce = async () => json({ revision });
  await read('/api/products', produce);
  revision = 2;
  const refreshed = await read('/api/products', produce, context(), { headers: { 'cache-control': 'no-cache' } });
  assert.equal(refreshed.headers.get('x-cache'), 'REFRESH');
  assert.equal((await refreshed.json()).revision, 2);
  const hit = await read('/api/products', produce);
  assert.equal(hit.headers.get('x-cache'), 'HIT');
  assert.equal((await hit.json()).revision, 2);
  const before = cache.operations.length;
  const uncached = await read('/api/products', produce, context(), { headers: { 'cache-control': 'no-store' } });
  assert.equal(uncached.headers.get('cache-control'), 'private, no-store');
  assert.equal(cache.operations.length, before);
});

test('errors, cookies and user-dependent variants are never cached publicly', async t => {
  const cache = installCache(t);
  const cases = [
    () => new Response('{"error":"oops"}', { status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' } }),
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'set-cookie': 'session=secret', 'cache-control': 'public, max-age=60' } }),
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'vary': 'Accept-Encoding, Cookie', 'cache-control': 'public, max-age=60' } }),
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'vary': 'X-User-ID', 'cache-control': 'public, max-age=60' } }),
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'vary': 'Accept-Encoding', 'cache-control': 'public, max-age=60' } }),
  ];
  for (const make of cases) {
    const response = await read('/api/categories', async () => make());
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
  assert.equal([...cache.entries.keys()].filter(key => key.includes('/api/categories')).length, 0);
});

test('cache failures do not make source reads or mutations fail', async t => {
  class BrokenCache extends FakeCache {
    async match() { throw new Error('cache unavailable'); }
    async put() { throw new Error('cache unavailable'); }
    async delete() { throw new Error('cache unavailable'); }
  }
  installCache(t, new BrokenCache());
  const response = await read('/api/config', async () => json({ siteName: 'test' }));
  assert.equal(response.headers.get('x-cache'), 'BYPASS');
  assert.equal((await response.json()).siteName, 'test');
  await assert.doesNotReject(invalidatePublicCache(request('/api/admin/config'), ['site']));
});

test('a failed background cache scheduler does not fail a successful source response', async t => {
  installCache(t);
  const response = await cachedPublicJson(request('/api/categories'), async () => json({ ok: true }), {
    waitUntil() { throw new Error('scheduler unavailable'); },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test('static shells and versioned assets have bounded caching; admin and cookies stay private', () => {
  const asset = () => new Response('content', { headers: { 'content-type': 'text/html' } });
  const account = withStaticCache(asset(), 'https://shop.example/account?tab=orders');
  assert.match(account.headers.get('cache-control'), /public, max-age=30/);
  const js = withStaticCache(asset(), 'https://shop.example/storefront.js?v=3');
  assert.match(js.headers.get('cache-control'), /max-age=86400.*immutable/);
  const unversioned = withStaticCache(asset(), 'https://shop.example/assets/product-1.svg');
  assert.match(unversioned.headers.get('cache-control'), /max-age=3600, s-maxage=3600/);
  const admin = withStaticCache(asset(), 'https://shop.example/admin');
  assert.equal(admin.headers.get('cache-control'), 'private, no-store');
  const cookie = withStaticCache(new Response('x', { headers: { 'set-cookie': 'session=secret' } }), 'https://shop.example/');
  assert.equal(cookie.headers.get('cache-control'), 'private, no-store');
  const userVary = withStaticCache(new Response('x', { headers: { vary: 'Cookie' } }), 'https://shop.example/');
  assert.equal(userVary.headers.get('cache-control'), 'private, no-store');
  const originalPrivate = withStaticCache(new Response('x', { headers: { 'cache-control': 'private, no-store' } }), 'https://shop.example/');
  assert.equal(originalPrivate.headers.get('cache-control'), 'private, no-store');
  const notModified = withStaticCache(new Response(null, { status: 304 }), 'https://shop.example/');
  assert.equal(notModified.status, 304);
  assert.match(notModified.headers.get('cache-control'), /max-age=30/);
});

test('private Worker endpoints never access the shared cache, and static HEAD is supported', async t => {
  const cache = installCache(t);
  for (const path of ['/api/auth/me', '/api/orders', '/api/access', '/api/library', '/api/subscriptions', '/api/subscriptions/p_test/updates', '/api/subscriptions/p_test/updates/u_test/file', '/api/admin/status', '/api/admin/agent/tokens', '/api/admin/agent/pairing/pair_00000000-0000-4000-8000-000000000001', '/api/download/example']) {
    const response = await worker.fetch(request(path), {});
    assert.match(response.headers.get('cache-control'), /private, no-store/, path);
  }
  const pairing = await worker.fetch(request('/api/agent/pair', { method: 'POST', body: '{"code":"1234567890"}' }), {});
  assert.match(pairing.headers.get('cache-control'), /private, no-store/);
  assert.equal(cache.operations.length, 0);
  const response = await worker.fetch(request('/account', { method: 'HEAD' }), {
    ASSETS: { async fetch(req) { assert.equal(req.method, 'HEAD'); return new Response(null, { headers: { 'content-type': 'text/html' } }); } },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /public, max-age=30/);
});

function catalogDatabase(role = 'user') {
  const product = {
    id: 'p_1', title: '测试商品', summary: '', description: '', price_points: 10,
    cover_url: '', category_id: 'cat_1', tags: '["设计"]', delivery_type: 'TEXT',
    delivery_text: 'secret delivery', delivery_url: '', file_key: '', file_name: '',
    stock: 2, sold_count: 0, status: 'ACTIVE', sort_order: 0, created_at: '', updated_at: '',
  };
  const orders = new Map(), jobs = new Map(), settings = new Map();
  const db = {
    product,
    async batch(statements) {
      const first = statements[0].sql;
      if (first.startsWith('UPDATE products SET stock=stock-1')) {
        if (product.status !== 'ACTIVE' || product.stock === 0) return [0,0,0,0].map(changes => ({ meta: { changes } }));
        if (product.stock !== null) product.stock--;
        product.sold_count++;
        const [key, order_no, user_id, created_at] = statements[1].values;
        if (orders.has(key)) throw new Error('duplicate order');
        orders.set(key, { ...product, idempotency_key: key, order_no, user_id, product_id: product.id, status: 'PENDING', created_at, bonus_points_used: 0, processing_token: null });
        return [1,1,0,0].map(changes => ({ meta: { changes } }));
      }
      if (first.startsWith('UPDATE bonus_wallets SET balance=balance+')) {
        const key = statements[3].values[0], order = orders.get(key);
        if (!order || order.status !== 'PENDING' || order.processing_token !== statements[3].values[1]) return [0,0,0,0].map(changes => ({ meta: { changes } }));
        if (product.stock !== null) product.stock++;
        product.sold_count = Math.max(0, product.sold_count - 1);
        order.status = 'FAILED';
        return [0,0,1,1].map(changes => ({ meta: { changes } }));
      }
      throw new Error('Unexpected batch: ' + first);
    },
    prepare(sql) {
      let args = [];
      return {
        sql,
        get values() { return args; },
        bind(...values) { args = values; return this; },
        async first() {
          if (sql.includes('FROM sessions s JOIN users u')) return { user_id: 'user_1', email: 'test@example.com', role, disabled: 0, expires_at: 9999999999 };
          if (sql.startsWith('SELECT value FROM settings')) return settings.has(args[0]) ? { value: settings.get(args[0]) } : null;
          if (sql.startsWith('SELECT * FROM products WHERE id=')) return args[0] === product.id ? { ...product } : null;
          if (sql.startsWith('SELECT * FROM orders WHERE idempotency_key=')) return orders.get(args[0]) || null;
          if (sql.startsWith('SELECT idempotency_key FROM orders WHERE user_id=')) return [...orders.values()].find(order => order.user_id === args[0] && order.product_id === args[1] && order.status === 'PENDING') || null;
          if (sql.startsWith('SELECT * FROM consumption_jobs WHERE idempotency_key=')) return jobs.get(args[0]) || null;
          throw new Error('Unexpected first: ' + sql);
        },
        async all() {
          if (sql.startsWith('SELECT id,parent_id FROM categories')) return { results: [{ id: 'cat_1', parent_id: null }] };
          if (sql.startsWith('SELECT * FROM products')) return { results: product.status === 'ACTIVE' ? [{ ...product }] : [] };
          if (sql.startsWith("SELECT * FROM orders WHERE user_id=? AND status='PENDING'")) return { results: [...orders.values()].filter(order => order.status === 'PENDING') };
          if (sql.startsWith('SELECT * FROM orders WHERE user_id=')) return { results: [...orders.values()] };
          throw new Error('Unexpected all: ' + sql);
        },
        async run() {
          if (sql.startsWith('UPDATE orders SET processing_token=?,processing_until=?')) {
            const order = orders.get(args[2]);
            if (!order || order.status !== 'PENDING' || order.processing_token) return { meta: { changes: 0 } };
            order.processing_token = args[0];
          } else if (sql.startsWith('UPDATE orders SET processing_token=NULL')) {
            const order = orders.get(args[0]); if (order?.processing_token === args[1]) order.processing_token = null;
          } else if (sql.startsWith("UPDATE orders SET status='DELIVERED'")) {
            const order = orders.get(args[1]); if (order) { order.status = 'DELIVERED'; order.delivered_at = args[0]; }
          } else if (sql.startsWith("UPDATE consumption_jobs SET status='SUBMITTED'")) {
            const job = jobs.get(args[1]), order = orders.get(args[2]); if (!job || !order || order.processing_token !== args[3] || job.status !== 'PREPARING') return { meta: { changes: 0 } }; job.status = 'SUBMITTED';
          } else if (sql.startsWith('UPDATE products SET stock=stock-1')) {
            if (product.status !== 'ACTIVE' || product.stock === 0) return { meta: { changes: 0 } };
            if (product.stock !== null) product.stock--;
            product.sold_count++;
          } else if (sql.startsWith('UPDATE products SET\n        stock = CASE')) {
            if (product.stock !== null) product.stock++;
            product.sold_count = Math.max(0, product.sold_count - 1);
          } else if (sql.startsWith('INSERT INTO orders')) {
            const [key, order_no, user_id, product_id, title, price_points, delivery_type, delivery_text, delivery_url, file_key, file_name, status, created_at] = args;
            orders.set(key, { idempotency_key: key, order_no, user_id, product_id, title, price_points, delivery_type, delivery_text, delivery_url, file_key, file_name, status, created_at });
          } else if (sql.startsWith('INSERT INTO consumption_jobs')) {
            const [key, user_id, amount, reason, status] = args;
            jobs.set(key, { user_id, amount, reason, status, response_json: '{}' });
          } else if (sql.startsWith('UPDATE consumption_jobs SET')) {
            if (jobs.has(args[3])) { jobs.get(args[3]).response_json = args[1]; jobs.get(args[3]).status = args[0]; }
          } else if (sql.startsWith('UPDATE orders SET status=?')) {
            const order = orders.get(args[1]);
            if (order) order.status = args[0];
          } else if (sql.startsWith('INSERT INTO settings')) {
            settings.set(args[0], args[1]);
          } else if (sql.startsWith('DELETE FROM settings')) {
            settings.delete(args[0]);
          } else if (sql.startsWith('INSERT INTO admin_audit')) {
            // Audit writes are irrelevant to this in-memory test.
          } else {
            throw new Error('Unexpected run: ' + sql);
          }
          return { meta: { changes: 1 } };
        },
      };
    },
  };
  return db;
}

async function callWorker(env, path, options) {
  const ctx = context();
  const response = await worker.fetch(request(path, options), env, ctx);
  await ctx.flush();
  return response;
}

test('stock reservation invalidates cached filters before upstream completes, and sync release invalidates again', { timeout: 5000 }, async t => {
  installCache(t);
  const db = catalogDatabase();
  const env = { DB: db, YIRENFU_API_KEY: 'local-test-key' };
  let releaseConsume, signalConsume, sync = false;
  const consumeGate = new Promise(resolve => { releaseConsume = resolve; });
  const consumeStarted = new Promise(resolve => { signalConsume = resolve; });
  const originalFetch = globalThis.fetch;
  t.after(() => { releaseConsume(); globalThis.fetch = originalFetch; });
  globalThis.fetch = async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/capabilities')) return json({ capabilities: { entitlement_query: true, consumption: true } });
    if (path.endsWith('/access')) return json({ requires_consumption: true, access_granted: true, remaining: 100 });
    if (path.endsWith('/consumption')) return json({ status: sync ? 'FAILED' : 'UNKNOWN' });
    if (path.endsWith('/consume')) {
      signalConsume();
      await consumeGate;
      return json({ status: 'PROCESSING' });
    }
    throw new Error('Unexpected upstream request ' + url);
  };

  const path = '/api/products?tag=设计&category=cat_1';
  const warm = await callWorker(env, path);
  const publicProduct = (await warm.json()).items[0];
  assert.equal(publicProduct.stock, 2);
  assert.equal('delivery_text' in publicProduct, false);
  assert.equal((await callWorker(env, path)).headers.get('x-cache'), 'HIT');
  const purchase = worker.fetch(request('/api/products/p_1/purchase', {
    method: 'POST', headers: { cookie: 'onepay_session=local-test', 'content-type': 'application/json' },
    body: JSON.stringify({ idempotency_key: 'local-order-1' }),
  }), env, context());
  await consumeStarted;
  const reserved = await callWorker(env, path);
  assert.equal(reserved.headers.get('x-cache'), 'MISS');
  assert.equal((await reserved.json()).items[0].stock, 1);
  releaseConsume();
  const pending = await purchase;
  assert.equal(pending.status, 202);
  assert.equal(pending.headers.get('cache-control'), 'private, no-store');
  assert.equal((await callWorker(env, path)).headers.get('x-cache'), 'HIT');

  sync = true;
  const synced = await callWorker(env, '/api/orders/sync', {
    method: 'POST', headers: { cookie: 'onepay_session=local-test', 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(synced.status, 200);
  assert.equal((await synced.json()).synced, 1);
  const restored = await callWorker(env, path);
  assert.equal(restored.headers.get('x-cache'), 'MISS');
  assert.equal((await restored.json()).items[0].stock, 2);
});

test('definitive purchase failure rolls stock back and expires cached inventory', async t => {
  const cache = installCache(t);
  const db = catalogDatabase();
  const env = { DB: db, YIRENFU_API_KEY: 'local-test-key' };
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async url => {
    if (String(url).endsWith('/capabilities')) return json({ capabilities: { entitlement_query: true } });
    if (String(url).endsWith('/access')) return json({ requires_consumption: true, access_granted: true, remaining: 0 });
    throw new Error('Unexpected upstream request ' + url);
  };
  const path = '/api/products?tag=设计';
  await callWorker(env, path);
  assert.equal((await callWorker(env, path)).headers.get('x-cache'), 'HIT');
  const result = await callWorker(env, '/api/products/p_1/purchase', {
    method: 'POST', headers: { cookie: 'onepay_session=local-test', 'content-type': 'application/json' },
    body: JSON.stringify({ idempotency_key: 'local-order-2' }),
  });
  assert.equal(result.status, 402);
  assert.equal((await result.json()).error_code, 'POINTS_INSUFFICIENT');
  const resultAfter = await callWorker(env, path);
  assert.equal(resultAfter.headers.get('x-cache'), 'MISS');
  assert.equal((await resultAfter.json()).items[0].stock, 2);
  const orders = await callWorker(env, '/api/orders', { headers: { cookie: 'onepay_session=local-test' } });
  assert.equal((await orders.json()).items[0].status, 'FAILED');
  assert.ok(cache.operations.filter(([op, key]) => op === 'put' && key.includes('/generation/catalog')).length >= 3);
});

test('out-of-stock rejection expires a stale local product view', async t => {
  installCache(t);
  const db = catalogDatabase();
  const env = { DB: db, YIRENFU_API_KEY: 'local-test-key' };
  const path = '/api/products?category=cat_1';
  await callWorker(env, path);
  assert.equal((await callWorker(env, path)).headers.get('x-cache'), 'HIT');
  db.product.stock = 0; // Simulate another location selling the last item.
  const result = await callWorker(env, '/api/products/p_1/purchase', {
    method: 'POST', headers: { cookie: 'onepay_session=local-test', 'content-type': 'application/json' },
    body: JSON.stringify({ idempotency_key: 'local-order-3' }),
  });
  assert.equal(result.status, 409);
  assert.equal((await result.json()).error_code, 'OUT_OF_STOCK');
  const after = await callWorker(env, path);
  assert.equal(after.headers.get('x-cache'), 'MISS');
  assert.equal((await after.json()).items[0].stock, 0);
});

test('changing and clearing an admin API key expires plans without expiring the catalog', async t => {
  installCache(t);
  const db = catalogDatabase('admin');
  const env = { DB: db, YIRENFU_API_KEY: 'old-fake-key' };
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).endsWith('/product'));
    return json({ label: options.headers.Authorization });
  };
  await callWorker(env, '/api/products');
  let plan = await callWorker(env, '/api/product');
  assert.equal((await plan.json()).label, 'Bearer old-fake-key');
  assert.equal((await callWorker(env, '/api/product')).headers.get('x-cache'), 'HIT');
  const adminRequest = body => ({
    method: 'POST', headers: { cookie: 'onepay_admin_session=local-test', 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const updated = await callWorker(env, '/api/admin/api-key', adminRequest({ value: 'new-fake-key' }));
  assert.equal(updated.status, 200);
  plan = await callWorker(env, '/api/product');
  assert.equal(plan.headers.get('x-cache'), 'MISS');
  assert.equal((await plan.json()).label, 'Bearer new-fake-key');
  assert.equal((await callWorker(env, '/api/products')).headers.get('x-cache'), 'HIT');
  const cleared = await callWorker(env, '/api/admin/api-key', adminRequest({ clear: true }));
  assert.equal(cleared.status, 200);
  plan = await callWorker(env, '/api/product');
  assert.equal(plan.headers.get('x-cache'), 'MISS');
  assert.equal((await plan.json()).label, 'Bearer old-fake-key');
});

test('generation marker eviction never revives older cached data', async t => {
  const cache = installCache(t);
  await read('/api/products', async () => json({ revision: 1 }));
  const marker = [...cache.entries.keys()].find(key => key.includes('/generation/catalog'));
  cache.entries.delete(marker);
  const response = await read('/api/products', async () => json({ revision: 2 }));
  assert.equal(response.headers.get('x-cache'), 'MISS');
  assert.equal((await response.json()).revision, 2);
});

test('repeated tag filters have distinct, order-independent public cache keys', async t => {
  installCache(t);
  let calls = 0;
  const produce = async () => json({ calls: ++calls });
  const first = await read('/api/products?tag=设计&tag=模板', produce);
  assert.equal(first.headers.get('x-cache'), 'MISS');
  const same = await read('/api/products?tag=模板&tag=设计&tag=设计', produce);
  assert.equal(same.headers.get('x-cache'), 'HIT');
  const onlyOne = await read('/api/products?tag=设计', produce);
  const other = await read('/api/products?tag=设计&tag=教程', produce);
  assert.equal(onlyOne.headers.get('x-cache'), 'MISS');
  assert.equal(other.headers.get('x-cache'), 'MISS');
  assert.equal(calls, 3);
});

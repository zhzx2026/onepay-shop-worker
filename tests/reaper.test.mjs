import test from 'node:test';
import assert from 'node:assert/strict';
import { reapPendingOrders } from '../src/reaper.js';

function createMockEnv({ orders = [], jobs = [], wallets = {}, products = {}, events = [], apiKey = 'sk_test_123' } = {}) {
  const orderMap = new Map(orders.map(o => [o.idempotency_key, { reconcile_attempts: 0, bonus_points_used: 0, product_kind: 'SINGLE', processing_token: null, processing_until: 0, ...o }]));
  const jobMap = new Map(jobs.map(j => [j.idempotency_key, { ...j }]));
  const walletMap = new Map(Object.entries(wallets).map(([u, b]) => [u, { user_id: u, balance: b }]));
  const productMap = new Map(Object.entries(products).map(([id, p]) => [id, { id, stock: 5, sold_count: 1, ...p }]));
  const eventList = events.map(e => ({ consumed_at: null, ...e }));
  const audits = [];
  const ledger = [];

  function prepare(sql) {
    const norm = sql.replace(/\s+/g, ' ').trim();
    return {
      sql: norm,
      args: [],
      bind(...args) {
        const bound = Object.create(this);
        bound.args = args;
        return bound;
      },
      async first() {
        const a = this.args;
        if (norm.startsWith('SELECT value FROM settings')) return null;
        if (norm.startsWith('UPDATE orders SET reconcile_attempts=')) {
          const o = orderMap.get(a[0]);
          if (!o) return null;
          o.reconcile_attempts = Number(o.reconcile_attempts || 0) + 1;
          return { n: o.reconcile_attempts };
        }
        if (norm.startsWith('SELECT status,response_json FROM consumption_jobs WHERE idempotency_key=?')) {
          return jobMap.get(a[0]) || null;
        }
        if (norm.startsWith("SELECT * FROM orders WHERE idempotency_key=? AND status='PENDING'")) {
          const o = orderMap.get(a[0]);
          return o && o.status === 'PENDING' ? { ...o } : null;
        }
        throw new Error('Unhandled first SQL: ' + norm);
      },
      async all() {
        const a = this.args;
        if (norm.startsWith("SELECT * FROM orders WHERE status='PENDING' AND created_at < ?")) {
          const cutoff = a[0];
          const limit = a[1];
          const results = [...orderMap.values()]
            .filter(o => o.status === 'PENDING' && o.created_at < cutoff)
            .sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)))
            .slice(0, limit)
            .map(o => ({ ...o }));
          return { results };
        }
        if (norm.startsWith('SELECT event_id, payload_json FROM webhook_events WHERE consumed_at IS NULL')) {
          const limit = a[0];
          return { results: eventList.filter(e => e.consumed_at === null).slice(0, limit).map(e => ({ ...e })) };
        }
        throw new Error('Unhandled all SQL: ' + norm);
      },
      async run() {
        const a = this.args;
        if (norm.startsWith("UPDATE orders SET processing_token=?, processing_until=? WHERE idempotency_key=? AND status='PENDING'")) {
          const [token, until, key, at] = a;
          const o = orderMap.get(key);
          if (!o || o.status !== 'PENDING' || (o.processing_token !== null && o.processing_until >= at)) {
            return { meta: { changes: 0 } };
          }
          o.processing_token = token;
          o.processing_until = until;
          return { meta: { changes: 1 } };
        }
        if (norm.startsWith('UPDATE orders SET processing_token=NULL,processing_until=0')) {
          const [key, token] = a;
          const o = orderMap.get(key);
          if (o && o.processing_token === token) {
            o.processing_token = null;
            o.processing_until = 0;
          }
          return { meta: { changes: 1 } };
        }
        if (norm.startsWith("UPDATE orders SET status='DELIVERED', delivered_at=? WHERE idempotency_key=? AND status='PENDING' AND processing_token=?")) {
          const [deliveredAt, key, token] = a;
          const o = orderMap.get(key);
          if (!o || o.status !== 'PENDING' || o.processing_token !== token) return { meta: { changes: 0 } };
          o.status = 'DELIVERED';
          o.delivered_at = deliveredAt;
          return { meta: { changes: 1 } };
        }
        if (norm.startsWith('UPDATE consumption_jobs SET status=?, response_json=?, updated_at=?')) {
          const [status, respJson, updatedAt, key, orderKey, token] = a;
          const o = orderMap.get(orderKey);
          const j = jobMap.get(key);
          if (o && o.processing_token === token && j) {
            j.status = status;
            j.response_json = respJson;
            j.updated_at = updatedAt;
          }
          return { meta: { changes: 1 } };
        }
        if (norm.startsWith('INSERT INTO admin_audit')) {
          const [id, action, target, detail, createdAt] = a;
          audits.push({ id, action, target, detail, created_at: createdAt });
          return { meta: { changes: 1 } };
        }
        if (norm.startsWith('UPDATE webhook_events SET consumed_at=? WHERE event_id=?')) {
          const [consumedAt, eventId] = a;
          const ev = eventList.find(e => e.event_id === eventId);
          if (ev) ev.consumed_at = consumedAt;
          return { meta: { changes: 1 } };
        }
        throw new Error('Unhandled run SQL: ' + norm);
      },
    };
  }

  return {
    YIRENFU_API_KEY: apiKey,
    YIRENFU_API_BASE: 'https://upstream.example.test/v1',
    state: { orderMap, jobMap, walletMap, productMap, eventList, audits, ledger },
    DB: {
      prepare,
      async batch(stmts) {
        // refundOrder batch (4 statements: bonus_wallets, bonus_ledger, products, orders)
        const lastArgs = stmts[3]?.args || [];
        const [key, token] = lastArgs;
        const o = orderMap.get(key);
        if (!o || o.status !== 'PENDING' || o.processing_token !== token) {
          return [{ meta: { changes: 0 } }, { meta: { changes: 0 } }, { meta: { changes: 0 } }, { meta: { changes: 0 } }];
        }
        if (Number(o.bonus_points_used) > 0) {
          const w = walletMap.get(o.user_id) || { user_id: o.user_id, balance: 0 };
          w.balance += Number(o.bonus_points_used);
          walletMap.set(o.user_id, w);
          ledger.push({ order_key: key, delta: Number(o.bonus_points_used), balance_after: w.balance });
        }
        const prod = productMap.get(o.product_id);
        if (prod) {
          if (prod.stock !== null) prod.stock += 1;
          prod.sold_count = Math.max(0, prod.sold_count - 1);
        }
        o.status = 'FAILED';
        return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }, { meta: { changes: 1 } }, { meta: { changes: 1 } }];
      },
    },
  };
}

test('reaper releases PREPARING orphan order and restores stock + bonus points without calling upstream', async () => {
  const env = createMockEnv({
    orders: [{ idempotency_key: 'ord_prep', user_id: 'u1', product_id: 'p1', price_points: 100, bonus_points_used: 30, status: 'PENDING', created_at: '2026-01-01T00:00:00.000Z' }],
    jobs: [{ idempotency_key: 'ord_prep', status: 'PREPARING', response_json: null }],
    wallets: { u1: 20 },
    products: { p1: { stock: 4, sold_count: 1 } },
  });
  const origFetch = globalThis.fetch;
  let fetchCalled = 0;
  globalThis.fetch = async () => { fetchCalled++; throw new Error('should not fetch'); };
  try {
    const report = await reapPendingOrders(env);
    assert.equal(fetchCalled, 0);
    assert.equal(report.released, 1);
    assert.equal(env.state.orderMap.get('ord_prep').status, 'FAILED');
    assert.equal(env.state.walletMap.get('u1').balance, 50);
    assert.equal(env.state.productMap.get('p1').stock, 5);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('reaper auto-delivers pure bonus order without refunding or calling upstream', async () => {
  const env = createMockEnv({
    orders: [{ idempotency_key: 'ord_bonus', user_id: 'u1', product_id: 'p1', price_points: 50, bonus_points_used: 50, status: 'PENDING', created_at: '2026-01-01T00:00:00.000Z' }],
  });
  const report = await reapPendingOrders(env);
  assert.equal(report.delivered, 1);
  assert.equal(report.released, 0);
  assert.equal(env.state.orderMap.get('ord_bonus').status, 'DELIVERED');
});

test('reaper keeps SUBMITTED order PENDING on 404/5xx (zero capital loss) and writes stalled audit on 12th attempt', async () => {
  const env = createMockEnv({
    orders: [{ idempotency_key: 'ord_sub_404', user_id: 'u2', product_id: 'p2', price_points: 80, bonus_points_used: 10, reconcile_attempts: 11, status: 'PENDING', created_at: '2026-01-01T00:00:00.000Z' }],
    jobs: [{ idempotency_key: 'ord_sub_404', status: 'SUBMITTED', response_json: null }],
    wallets: { u2: 0 },
    products: { p2: { stock: 0, sold_count: 1 } },
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"error":"not_found"}', { status: 404 });
  try {
    const report = await reapPendingOrders(env);
    assert.equal(report.pending, 1);
    assert.equal(report.released, 0);
    assert.equal(env.state.orderMap.get('ord_sub_404').status, 'PENDING');
    assert.equal(env.state.walletMap.get('u2').balance, 0);
    assert.equal(env.state.productMap.get('p2').stock, 0);
    assert.equal(env.state.audits.length, 1);
    assert.equal(env.state.audits[0].action, 'orders.reconcile_stalled');
    assert.equal(env.state.audits[0].target, 'ord_sub_404');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('webhook_events retains unconsumed event when order is locked (SKIPPED) or transient PENDING, then consumes on DELIVERED', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const env = createMockEnv({
    orders: [{
      idempotency_key: 'ord_wh_1',
      user_id: 'u3',
      product_id: 'p3',
      price_points: 60,
      bonus_points_used: 0,
      status: 'PENDING',
      created_at: new Date().toISOString(), // fresh order, only reachable via webhook_events
      processing_token: 'active_req_lock',
      processing_until: nowSec + 120,
    }],
    jobs: [{ idempotency_key: 'ord_wh_1', status: 'SUBMITTED', response_json: null }],
    events: [
      { event_id: 'evt_locked', payload_json: JSON.stringify({ data: { idempotency_key: 'ord_wh_1' } }) },
      { event_id: 'evt_noise', payload_json: JSON.stringify({ type: 'ping' }) },
    ],
  });

  const origFetch = globalThis.fetch;
  try {
    // Pass 1: order holds active lease -> SKIPPED -> evt_locked must NOT be marked consumed_at
    const r1 = await reapPendingOrders(env);
    assert.equal(r1.skipped, 1);
    assert.equal(r1.webhook_handled, 0);
    assert.equal(env.state.eventList.find(e => e.event_id === 'evt_locked').consumed_at, null);
    assert.notEqual(env.state.eventList.find(e => e.event_id === 'evt_noise').consumed_at, null);

    // Release lease, simulate transient 502 -> PENDING -> evt_locked still preserved
    const ord = env.state.orderMap.get('ord_wh_1');
    ord.processing_token = null;
    ord.processing_until = 0;
    globalThis.fetch = async () => new Response('bad gateway', { status: 502 });
    const r2 = await reapPendingOrders(env);
    assert.equal(r2.pending, 1);
    assert.equal(env.state.eventList.find(e => e.event_id === 'evt_locked').consumed_at, null);

    // Pass 3: upstream confirms SUCCEEDED -> order DELIVERED and evt_locked marked consumed_at
    globalThis.fetch = async () => new Response(JSON.stringify({ status: 'SUCCEEDED', confirmed: true }), { status: 200 });
    const r3 = await reapPendingOrders(env);
    assert.equal(r3.delivered, 1);
    assert.equal(r3.webhook_handled, 1);
    assert.equal(ord.status, 'DELIVERED');
    assert.notEqual(env.state.eventList.find(e => e.event_id === 'evt_locked').consumed_at, null);
  } finally {
    globalThis.fetch = origFetch;
  }
});

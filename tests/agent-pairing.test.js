import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, pbkdf2Sync } from 'node:crypto';
import worker from '../src/index.js';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch {}
const sqliteTest = (name, fn) => test(name, { skip: !DatabaseSync && 'requires Node 22 SQLite' }, fn);

async function makeDb({ oldSchema = false } = {}) {
  const raw = new DatabaseSync(':memory:');
  const names = ['0001_init.sql', '0002_users_and_admin.sql', '0003_products_and_orders.sql', '0004_user_admin_roles.sql', '0005_categories_and_tags.sql', '0006_bonus_points.sql', '0007_catalog_agent.sql', '0008_subscriptions_and_repeat.sql'];
  if (!oldSchema) names.push('0009_agent_pairing.sql', '0010_auth_throttle.sql');
  for (const name of names) raw.exec(await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  raw.exec(`INSERT INTO users(id,email,password_hash,created_at,role) VALUES
    ('admin_a','a@example.com','x','2026-01-01','admin'),
    ('admin_b','b@example.com','x','2026-01-01','admin'),
    ('user_a','user@example.com','x','2026-01-01','user')`);
  for (const [token, user, role] of [['session-a','admin_a','admin'], ['session-b','admin_b','admin'], ['session-user','user_a','user']]) {
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

class Bucket {
  constructor() { this.objects = new Map(); }
  async put(key, data, options) { this.objects.set(key, { data, ...options }); }
  async head(key) { return this.objects.get(key) || null; }
}

function req(path, { method = 'GET', body, admin = 'a', token, ip = '203.0.113.42', origin } = {}) {
  const headers = { 'cf-connecting-ip': ip };
  if (admin === 'a') headers.cookie = 'onepay_admin_session=session-a';
  else if (admin === 'b') headers.cookie = 'onepay_admin_session=session-b';
  else if (admin === 'user') headers.cookie = 'onepay_session=session-user';
  if (token) headers.authorization = 'Bearer ' + token;
  if (origin) headers.origin = origin;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new Request('https://shop.test' + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
const issue = (env, admin = 'a') => worker.fetch(req('/api/admin/agent/pairing', { method: 'POST', admin, body: {} }), env);
const exchange = (env, code, ip) => worker.fetch(req('/api/agent/pair', { method: 'POST', admin: null, ip, body: { code } }), env);
const bearer = (env, token) => worker.fetch(req('/api/agent/drafts', { method: 'POST', admin: null, token, body: {} }), env);

sqliteTest('admin pairs without a Worker Secret, then revokes the scoped 30-day token', async t => {
  const DB = await makeDb(), BUCKET = new Bucket(), env = { DB, BUCKET }; t.after(() => DB.raw.close());
  assert.equal((await issue(env, 'user')).status, 401);
  assert.equal((await issue({ DB }, 'a')).status, 503);
  const status = await (await worker.fetch(req('/api/admin/status'), env)).json();
  assert.equal(status.agentPairingReady, true); assert.equal(status.agentConfigured, false); assert.equal(status.storageConfigured, true);

  const issued = await issue(env), codeData = await issued.json();
  assert.equal(issued.status, 201); assert.equal(issued.headers.get('cache-control'), 'private, no-store');
  assert.match(codeData.code, /^\d{10}$/); assert.equal(codeData.expires_in, 300);
  assert.ok(Math.abs(Date.parse(codeData.expires_at) - Date.now() - 300000) < 2000);
  assert.ok(!JSON.stringify(DB.raw.prepare('SELECT * FROM agent_pair_codes').all()).includes(codeData.code));
  const statusPath = '/api/admin/agent/pairing/' + codeData.pair_id;
  const pendingText = await (await worker.fetch(req(statusPath), env)).text();
  assert.equal(JSON.parse(pendingText).status, 'PENDING'); assert.ok(!pendingText.includes(codeData.code));
  assert.equal((await (await worker.fetch(req(statusPath, { admin: 'b' }), env)).json()).status, 'CANCELED');

  const invalid = await exchange(env, codeData.code === '0000000000' ? '0000000001' : '0000000000');
  assert.equal(invalid.status, 401); assert.equal((await invalid.json()).error_code, 'PAIR_CODE_INVALID');
  const paired = await exchange(env, codeData.code), data = await paired.json();
  assert.equal(paired.status, 201); assert.equal(paired.headers.get('cache-control'), 'private, no-store');
  assert.equal((await (await worker.fetch(req(statusPath), env)).json()).status, 'USED');
  assert.match(data.access_token, /^agt_[A-Za-z0-9_-]{43}$/); assert.equal(data.token_type, 'Bearer'); assert.equal(data.expires_in, 30 * 86400);
  assert.ok(Math.abs(Date.parse(data.expires_at) - Date.now() - 30 * 86400 * 1000) < 2000);
  const stored = JSON.stringify(DB.raw.prepare('SELECT * FROM agent_tokens').all());
  assert.ok(!stored.includes(data.access_token)); assert.ok(!stored.includes(codeData.code));
  assert.equal((await exchange(env, codeData.code)).status, 401);
  assert.equal((await bearer(env, data.access_token)).status, 400); // authenticated; invalid draft payload
  assert.equal((await worker.fetch(req('/api/admin/products', { admin: null, token: data.access_token }), env)).status, 401);

  const form = new FormData(); form.append('file', new Blob(['pair test'], { type: 'text/plain' }), 'test.txt');
  const upload = await worker.fetch(new Request('https://shop.test/api/agent/uploads', { method: 'POST', headers: { authorization: 'Bearer ' + data.access_token }, body: form }), env);
  assert.equal(upload.status, 200); const file = await upload.json();
  const draft = await worker.fetch(req('/api/agent/drafts', { method: 'POST', admin: null, token: data.access_token, body: { idempotency_key: 'agent-pair-job-001', title: '配对草稿', price_points: 10, file_key: file.key, file_name: file.name, status: 'ACTIVE' } }), env);
  assert.equal(draft.status, 201); assert.equal((await draft.json()).product.status, 'HIDDEN');

  const listResponse = await worker.fetch(req('/api/admin/agent/tokens'), env), listText = await listResponse.text();
  assert.equal(listResponse.headers.get('cache-control'), 'private, no-store');
  assert.equal(JSON.parse(listText).items[0].id, data.credential_id);
  for (const secret of [data.access_token, codeData.code, 'token_hash', 'code_hash']) assert.ok(!listText.includes(secret));
  assert.equal((await worker.fetch(req('/api/admin/agent/tokens', { admin: 'user' }), env)).status, 401);
  assert.equal((await worker.fetch(req('/api/admin/agent/tokens/' + data.credential_id, { method: 'DELETE' }), env)).status, 200);
  assert.equal((await bearer(env, data.access_token)).status, 401);
  assert.equal((await worker.fetch(req('/api/admin/agent/tokens/' + data.credential_id, { method: 'DELETE' }), env)).status, 200);
  const audit = JSON.stringify(DB.raw.prepare('SELECT * FROM admin_audit').all());
  assert.ok(!audit.includes(data.access_token)); assert.ok(!audit.includes(codeData.code));
});

sqliteTest('codes are invalidated by replacement, expiry, cancel or competing exchange', async t => {
  const DB = await makeDb(), env = { DB, BUCKET: new Bucket() }; t.after(() => DB.raw.close());
  const first = await (await issue(env)).json(), replacement = await (await issue(env)).json();
  assert.equal((await exchange(env, first.code, '203.0.113.1')).status, 401);
  DB.raw.exec('UPDATE agent_pair_codes SET expires_at=0');
  assert.equal((await exchange(env, replacement.code, '203.0.113.2')).status, 401);
  const canceled = await (await issue(env)).json();
  assert.equal((await worker.fetch(req('/api/admin/agent/pairing', { method: 'DELETE' }), env)).status, 200);
  assert.equal((await exchange(env, canceled.code, '203.0.113.3')).status, 401);
  const raced = await (await issue(env)).json();
  const results = await Promise.all([exchange(env, raced.code, '203.0.113.4'), exchange(env, raced.code, '203.0.113.5')]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 401]);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM agent_tokens').get().n, 1);
  const winner = await results.find(r => r.status === 201).json();
  DB.raw.prepare('UPDATE agent_tokens SET expires_at=? WHERE id=?').run(Math.floor(Date.now() / 1000), winner.credential_id);
  assert.equal((await bearer(env, winner.access_token)).status, 401);
});

sqliteTest('pairing limits attempts atomically per client and globally', async t => {
  const DB = await makeDb(), env = { DB, BUCKET: new Bucket() }; t.after(() => DB.raw.close());
  const results = await Promise.all(Array.from({ length: 9 }, () => exchange(env, 'bad-format', '192.0.2.1')));
  assert.deepEqual(results.map(r => r.status).sort((a, b) => a - b), [400,400,400,400,400,429,429,429,429]);
  assert.equal(results.find(r => r.status === 429).headers.get('retry-after'), '300');
  // Clear the prior window, then use different client IPs to exercise the global limit.
  DB.raw.exec('DELETE FROM agent_pair_limits');
  for (let i = 1; i <= 100; i++) assert.equal((await exchange(env, 'bad-format', `198.51.100.${i}`)).status, 400);
  assert.equal((await exchange(env, 'bad-format', '198.51.100.101')).status, 429);
  assert.ok(!JSON.stringify(DB.raw.prepare('SELECT * FROM agent_pair_limits').all()).includes('198.51.100.1'));
  DB.raw.exec('UPDATE agent_pair_limits SET window_start=0');
  assert.equal((await exchange(env, 'bad-format', '192.0.2.1')).status, 400);
});

sqliteTest('disabled, demoted or password-reset issuers permanently lose their credentials', async t => {
  const DB = await makeDb(), env = { DB, BUCKET: new Bucket() }; t.after(() => DB.raw.close());
  for (const change of ['status', 'role', 'reset-password']) {
    // Restore a fresh admin session after each privileged account change.
    DB.raw.exec("UPDATE users SET role='admin',disabled=0 WHERE id='admin_b'");
    DB.raw.prepare('INSERT OR REPLACE INTO sessions(token_hash,user_id,role,expires_at,created_at) VALUES(?,?,?,?,?)')
      .run(createHash('sha256').update('session-b').digest('base64url'), 'admin_b', 'admin', 9999999999, '2026-01-01');
    const initial = await (await issue(env, 'b')).json(), token = await (await exchange(env, initial.code, `203.0.113.${20 + ['status', 'role', 'reset-password'].indexOf(change)}`)).json();
    const pending = await (await issue(env, 'b')).json();
    const body = change === 'status' ? { disabled: true } : change === 'role' ? { role: 'user' } : { password: 'new-password-123' };
    assert.equal((await worker.fetch(req('/api/admin/users/admin_b/' + change, { method: 'POST', body }), env)).status, 200);
    assert.equal((await bearer(env, token.access_token)).status, 401);
    assert.equal((await exchange(env, pending.code, `203.0.113.${30 + ['status', 'role', 'reset-password'].indexOf(change)}`)).status, 401);
    DB.raw.exec("UPDATE users SET role='admin',disabled=0 WHERE id='admin_b'");
    assert.equal((await bearer(env, token.access_token)).status, 401);
  }
});

sqliteTest('old installations keep legacy Agent auth, but pairing explains the missing migration', async t => {
  const DB = await makeDb({ oldSchema: true }), BUCKET = new Bucket(), secret = '0123456789abcdef0123456789abcdef'; t.after(() => DB.raw.close());
  const env = { DB, BUCKET, AGENT_API_TOKEN: secret };
  assert.equal((await bearer(env, secret)).status, 400);
  assert.equal((await issue(env)).status, 503);
  assert.equal((await exchange(env, '1234567890')).status, 503);
  const status = await (await worker.fetch(req('/api/admin/status'), env)).json();
  assert.equal(status.agentConfigured, true); assert.equal(status.agentPairingReady, false);
  const crossOrigin = await worker.fetch(req('/api/agent/pair', { method: 'POST', admin: null, origin: 'https://evil.test', body: { code: '1234567890' } }), env);
  assert.equal(crossOrigin.status, 403);
});

sqliteTest('leading zeroes survive pairing and the anonymous body is strictly bounded', async t => {
  const DB = await makeDb(), env = { DB, BUCKET: new Bucket() }; t.after(() => DB.raw.close());
  const code = '0000012345', salt = 'local-test-salt', now = Math.floor(Date.now() / 1000);
  const hash = pbkdf2Sync('onepay-agent-pair-v1:' + code, salt, 100000, 32, 'sha256').toString('base64url');
  DB.raw.prepare('INSERT INTO agent_pair_settings(singleton,code_salt) VALUES(1,?)').run(salt);
  DB.raw.prepare('INSERT INTO agent_pair_codes(code_hash,id,issued_by,label,created_at,expires_at) VALUES(?,?,?,?,?,?)')
    .run(hash, 'pair_00000000-0000-4000-8000-000000000001', 'admin_a', '', now, now + 300);
  assert.equal((await exchange(env, Number(code), '203.0.113.90')).status, 400);
  assert.equal((await exchange(env, code, '203.0.113.91')).status, 201);
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(2048))); controller.close(); } });
  const overlong = new Request('https://shop.test/api/agent/pair', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.92' }, body, duplex: 'half' });
  assert.equal((await worker.fetch(overlong, env)).status, 413);
});

sqliteTest('a failed token insert rolls back consumption so the same code can be retried', async t => {
  const DB = await makeDb(), env = { DB, BUCKET: new Bucket() }; t.after(() => DB.raw.close());
  const issued = await (await issue(env)).json();
  DB.raw.exec("CREATE TRIGGER reject_agent_token BEFORE INSERT ON agent_tokens BEGIN SELECT RAISE(ABORT,'simulated write error'); END");
  assert.equal((await exchange(env, issued.code, '203.0.113.93')).status, 503);
  assert.equal(DB.raw.prepare('SELECT used_at FROM agent_pair_codes').get().used_at, null);
  DB.raw.exec('DROP TRIGGER reject_agent_token');
  assert.equal((await exchange(env, issued.code, '203.0.113.94')).status, 201);
});

sqliteTest('deleting an issuing admin removes their pending codes and tokens without affecting another admin', async t => {
  const DB = await makeDb(), env = { DB, BUCKET: new Bucket() }; t.after(() => DB.raw.close());
  const aCode = await (await issue(env, 'a')).json();
  const bCode = await (await issue(env, 'b')).json();
  const bPair = await (await exchange(env, bCode.code, '203.0.113.95')).json();
  const pendingB = await (await issue(env, 'b')).json();
  assert.equal((await worker.fetch(req('/api/admin/users/admin_b', { method: 'DELETE' }), env)).status, 200);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS n FROM agent_tokens WHERE issued_by='admin_b'").get().n, 0);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS n FROM agent_pair_codes WHERE issued_by='admin_b'").get().n, 0);
  assert.equal((await bearer(env, bPair.access_token)).status, 401);
  assert.equal((await exchange(env, pendingB.code, '203.0.113.96')).status, 401);
  assert.equal((await exchange(env, aCode.code, '203.0.113.97')).status, 201);
});

sqliteTest('administrator labels are bounded and cannot change Agent privileges', async t => {
  const DB = await makeDb(), env = { DB, BUCKET: new Bucket() }; t.after(() => DB.raw.close());
  assert.equal((await worker.fetch(req('/api/admin/agent/pairing', { method: 'POST', body: { label: 'x'.repeat(51) } }), env)).status, 400);
  assert.equal((await worker.fetch(req('/api/admin/agent/pairing', { method: 'POST', body: { label: 'line\nbreak' } }), env)).status, 400);
  assert.equal((await worker.fetch(req('/api/admin/agent/pairing', { method: 'POST', body: { label: 42 } }), env)).status, 400);
  const issued = await (await worker.fetch(req('/api/admin/agent/pairing', { method: 'POST', body: { label: '<img src=x onerror=alert(1)>' } }), env)).json();
  const paired = await (await exchange(env, issued.code, '203.0.113.98')).json();
  assert.equal((await bearer(env, paired.access_token)).status, 400);
  const list = await (await worker.fetch(req('/api/admin/agent/tokens'), env)).json();
  assert.equal(list.items[0].label, '<img src=x onerror=alert(1)>');
});

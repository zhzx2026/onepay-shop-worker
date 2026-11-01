// Scoped, revocable Agent credentials. Raw codes and bearer tokens are only
// returned at creation/exchange time, never persisted or logged.
const encoder = new TextEncoder();
export const PAIR_TTL_SECONDS = 300;
export const AGENT_TOKEN_TTL_SECONDS = 30 * 86400;
export const PAIR_IP_LIMIT = 5;
export const PAIR_GLOBAL_LIMIT = 100;
const PAIR_HASH_ROUNDS = 100000;

const seconds = () => Math.floor(Date.now() / 1000);
const b64 = value => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const digest = async value => b64(await crypto.subtle.digest('SHA-256', encoder.encode(value)));

async function codeDigest(code, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(`onepay-agent-pair-v1:${code}`), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations: PAIR_HASH_ROUNDS, hash: 'SHA-256' }, key, 256));
}

function randomCode() {
  let code = '';
  while (code.length < 10) {
    // Rejection sampling makes every decimal digit equally likely.
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < 250 && code.length < 10) code += String(byte % 10);
    }
  }
  return code;
}

export async function pairingSchemaReady(env) {
  try {
    await env.DB.prepare(`SELECT (SELECT 1 FROM agent_pair_settings LIMIT 1) AS s,
      (SELECT 1 FROM agent_pair_codes LIMIT 1) AS c,
      (SELECT 1 FROM agent_pair_limits LIMIT 1) AS l,
      (SELECT 1 FROM agent_tokens LIMIT 1) AS t`).first();
    return true;
  } catch { return false; }
}

async function installationSalt(env) {
  const fresh = b64(crypto.getRandomValues(new Uint8Array(16)));
  await env.DB.prepare('INSERT OR IGNORE INTO agent_pair_settings(singleton,code_salt) VALUES(1,?)').bind(fresh).run();
  const row = await env.DB.prepare('SELECT code_salt FROM agent_pair_settings WHERE singleton=1').first();
  if (!row?.code_salt) throw new Error('pairing salt unavailable');
  return row.code_salt;
}

export async function issuePairCode(env, adminId, label = '') {
  const salt = await installationSalt(env);
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = randomCode(), hash = await codeDigest(code, salt), pairId = 'pair_' + crypto.randomUUID();
    const at = seconds(), expires = at + PAIR_TTL_SECONDS;
    try {
      const result = await env.DB.batch([
        // A newly generated code invalidates this admin's earlier unused codes.
        env.DB.prepare('DELETE FROM agent_pair_codes WHERE expires_at<=? OR (issued_by=? AND used_at IS NULL)').bind(at, adminId),
        env.DB.prepare(`INSERT INTO agent_pair_codes(code_hash,id,issued_by,label,created_at,expires_at)
          SELECT ?,?,id,?,?,? FROM users WHERE id=? AND role='admin' AND COALESCE(disabled,0)=0`)
          .bind(hash, pairId, label, at, expires, adminId),
      ]);
      if (!Number(result[1]?.meta?.changes || 0)) return null;
      return { code, pair_id: pairId, expires_at: new Date(expires * 1000).toISOString(), expires_in: PAIR_TTL_SECONDS };
    } catch (error) {
      // An astronomically unlikely collision can be retried with another code.
      if (!/unique|constraint/i.test(String(error?.message || '')) || attempt === 2) throw error;
    }
  }
  return null;
}

export async function cancelPairCodes(env, adminId) {
  await env.DB.prepare('DELETE FROM agent_pair_codes WHERE issued_by=? AND used_at IS NULL').bind(adminId).run();
}

export async function pairCodeStatus(env, adminId, pairId) {
  const row = await env.DB.prepare('SELECT used_at,expires_at FROM agent_pair_codes WHERE id=? AND issued_by=?').bind(pairId, adminId).first();
  if (!row) return { status: 'CANCELED' };
  return { status: row.used_at !== null ? 'USED' : Number(row.expires_at) <= seconds() ? 'EXPIRED' : 'PENDING' };
}

export async function recordPairAttempt(env, rawIp) {
  const at = seconds();
  // Only CF-Connecting-IP is used; never trust client-supplied X-Forwarded-For.
  const value = String(rawIp || '').trim().toLowerCase();
  const ip = /^[0-9a-f:.]{2,64}$/.test(value) ? value : 'unknown';
  const scope = 'ip:' + await digest('agent-pair-rate-v1:' + ip);
  const result = await env.DB.batch([
    env.DB.prepare('DELETE FROM agent_pair_limits WHERE window_start<=?').bind(at - PAIR_TTL_SECONDS),
    env.DB.prepare(`INSERT INTO agent_pair_limits(scope,window_start,attempts) VALUES(?,?,1)
      ON CONFLICT(scope) DO UPDATE SET attempts=attempts+1 WHERE attempts<?`).bind(scope, at, PAIR_IP_LIMIT),
    // Blocked clients do not consume the shared budget. Both counters are
    // checked in the same D1 transaction even under concurrent requests.
    env.DB.prepare(`INSERT INTO agent_pair_limits(scope,window_start,attempts)
      SELECT 'global',?,1 WHERE changes()=1
      ON CONFLICT(scope) DO UPDATE SET attempts=attempts+1 WHERE attempts<?`).bind(at, PAIR_GLOBAL_LIMIT),
  ]);
  return Boolean(Number(result[1]?.meta?.changes || 0) && Number(result[2]?.meta?.changes || 0));
}

export async function exchangePairCode(env, code) {
  const setting = await env.DB.prepare('SELECT code_salt FROM agent_pair_settings WHERE singleton=1').first();
  if (!setting?.code_salt) return null;
  const codeHash = await codeDigest(code, setting.code_salt);
  const token = 'agt_' + b64(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await digest(token), tokenId = 'agt_' + crypto.randomUUID();
  const at = seconds(), expires = at + AGENT_TOKEN_TTL_SECONDS;
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE agent_pair_codes SET used_at=?
      WHERE code_hash=? AND used_at IS NULL AND expires_at>?
      AND EXISTS (SELECT 1 FROM users WHERE id=agent_pair_codes.issued_by AND role='admin' AND COALESCE(disabled,0)=0)`)
      .bind(at, codeHash, at),
    env.DB.prepare(`INSERT INTO agent_tokens(id,token_hash,issued_by,label,created_at,expires_at)
      SELECT ?,?,issued_by,label,?,? FROM agent_pair_codes WHERE code_hash=? AND used_at=? AND changes()=1`)
      .bind(tokenId, tokenHash, at, expires, codeHash, at),
  ]);
  if (!Number(result[0]?.meta?.changes || 0) || !Number(result[1]?.meta?.changes || 0)) return null;
  return { access_token: token, token_type: 'Bearer', credential_id: tokenId,
    expires_at: new Date(expires * 1000).toISOString(), expires_in: AGENT_TOKEN_TTL_SECONDS };
}

export async function validPairedAgent(env, token) {
  if (!/^agt_[A-Za-z0-9_-]{43}$/.test(token)) return false;
  const row = await env.DB.prepare(`SELECT t.id FROM agent_tokens t JOIN users u ON u.id=t.issued_by
    WHERE t.token_hash=? AND t.revoked_at IS NULL AND t.expires_at>? AND u.role='admin' AND COALESCE(u.disabled,0)=0`)
    .bind(await digest(token), seconds()).first();
  return Boolean(row);
}

export async function listAgentTokens(env, offset = 0) {
  const rows = await env.DB.prepare(`SELECT t.id,t.label,t.created_at,t.expires_at,t.revoked_at,u.email AS issued_by
    FROM agent_tokens t LEFT JOIN users u ON u.id=t.issued_by
    ORDER BY t.created_at DESC,t.id DESC LIMIT 51 OFFSET ?`).bind(offset).all();
  const results = rows.results || [];
  return { items: results.slice(0, 50), has_more: results.length > 50, next_offset: offset + 50 };
}

export async function revokeAgentToken(env, tokenId) {
  const row = await env.DB.prepare('SELECT id FROM agent_tokens WHERE id=?').bind(tokenId).first();
  if (!row) return false;
  await env.DB.prepare('UPDATE agent_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL').bind(seconds(), tokenId).run();
  return true;
}

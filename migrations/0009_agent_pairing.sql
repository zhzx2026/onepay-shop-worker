-- One-time, five-minute pairing codes and 30-day scoped Agent credentials.
-- The raw pairing code and bearer token are never stored in the database.
CREATE TABLE IF NOT EXISTS agent_pair_settings (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  code_salt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_pair_codes (
  code_hash TEXT PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  issued_by TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS agent_pair_codes_issuer_idx ON agent_pair_codes(issued_by, expires_at);
CREATE INDEX IF NOT EXISTS agent_pair_codes_expiry_idx ON agent_pair_codes(expires_at);

CREATE TABLE IF NOT EXISTS agent_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  issued_by TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS agent_tokens_issuer_idx ON agent_tokens(issued_by, created_at DESC);

-- Atomic per-client and global counters for the unauthenticated exchange endpoint.
-- IP addresses are represented only by hashes, never stored in plaintext.
-- Stale counters are cleaned up when a later pairing attempt occurs.
CREATE TABLE IF NOT EXISTS agent_pair_limits (
  scope TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_pair_limits_window_idx ON agent_pair_limits(window_start);

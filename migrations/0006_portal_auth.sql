-- Fase 21.2: portal.toolsnap.app — sessions + magic-link tokens.
-- Identity/auth only; money stays in balances/ledger untouched. The portal
-- Worker (private repo icosaedro-git/toolsnap-portal) shares this database;
-- migrations remain owned by THIS repo (single chain per DB).

CREATE TABLE IF NOT EXISTS portal_sessions (
  session_hash TEXT    PRIMARY KEY,  -- SHA-256 hex of the cookie token (plaintext never stored)
  account_id   TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,     -- unix seconds
  expires_at   INTEGER NOT NULL,     -- absolute expiry (30 days), no sliding renewal
  last_seen_at INTEGER,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_ps_account ON portal_sessions (account_id);
CREATE INDEX IF NOT EXISTS idx_ps_expires ON portal_sessions (expires_at);

CREATE TABLE IF NOT EXISTS magic_links (
  token_hash TEXT    PRIMARY KEY,    -- SHA-256 hex of the emailed token
  email      TEXT    NOT NULL,       -- lowercase
  ip         TEXT,                   -- CF-Connecting-IP at request time (rate limiting)
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,       -- created_at + 15 min
  used_at    INTEGER                 -- NULL = unused; consumed atomically (single use)
);
CREATE INDEX IF NOT EXISTS idx_ml_email ON magic_links (email, created_at);
CREATE INDEX IF NOT EXISTS idx_ml_ip    ON magic_links (ip, created_at);

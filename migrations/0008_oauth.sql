-- Fase 26: OAuth 2.1 + Dynamic Client Registration (DCR, RFC 7591).
--
-- Additive on top of the existing sk_ API-key rail — no change to how
-- money moves. A verified OAuth access token resolves to an account_id,
-- which uses the SAME synthetic address "acct:{account_id}" already used
-- by the fiat rail (see 0005_fiat_accounts.sql). balances/ledger/spend_nonces
-- are never touched by anything in this migration.
--
-- The Authorization Server (portal.toolsnap.app, repo toolsnap-portal) issues
-- rows here; the Resource Server (mcp.toolsnap.app, this repo) only reads them
-- to verify Bearer tokens. Tokens/codes are opaque, CSPRNG, ~256-bit — only
-- their SHA-256 hex is ever stored, same pattern as api_keys/portal_sessions.

-- Dynamically registered OAuth clients (DCR). client_id is public and stored
-- in plaintext; there is no client secret (public clients only, PKCE required).
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     TEXT    PRIMARY KEY,     -- 'oc_' + CSPRNG
  client_name   TEXT    NOT NULL,        -- attacker-controlled at DCR time; escape on render
  redirect_uris TEXT    NOT NULL,        -- JSON array of pre-validated redirect URIs
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);

-- Authorization codes: single-use, 5-minute TTL. grant_id is generated at
-- consent-approval time and copied onto the tokens minted from this code, so
-- a replayed code can revoke the whole grant it produced (OAuth 2.1 reuse
-- detection).
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash      TEXT    PRIMARY KEY,    -- SHA-256 hex of the code
  grant_id       TEXT    NOT NULL,       -- UUID, shared with the tokens issued from this code
  client_id      TEXT    NOT NULL,
  account_id     TEXT    NOT NULL,
  redirect_uri   TEXT    NOT NULL,
  code_challenge TEXT    NOT NULL,       -- PKCE S256, base64url
  scope          TEXT    NOT NULL DEFAULT 'mcp',
  resource       TEXT,                   -- RFC 8707, informational (single resource server today)
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  used_at        INTEGER                 -- NULL = unused; consumed atomically (single use)
);
CREATE INDEX IF NOT EXISTS idx_oc_expires ON oauth_codes (expires_at);

-- Access and refresh tokens. rotated_from links a refresh token to the one it
-- replaced, so presenting an already-rotated refresh token (reuse) is
-- detectable and revokes the entire grant.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash   TEXT    PRIMARY KEY,      -- SHA-256 hex
  token_id     TEXT    NOT NULL,         -- first 8 hex chars of the hash (public id, analytics/UI)
  kind         TEXT    NOT NULL CHECK (kind IN ('access', 'refresh')),
  grant_id     TEXT    NOT NULL,
  client_id    TEXT    NOT NULL,
  account_id   TEXT    NOT NULL,
  scope        TEXT    NOT NULL DEFAULT 'mcp',
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER,                  -- NULL = active
  rotated_from TEXT                      -- token_hash of the refresh token this one replaced
);
CREATE INDEX IF NOT EXISTS idx_ot_account ON oauth_tokens (account_id);
CREATE INDEX IF NOT EXISTS idx_ot_grant   ON oauth_tokens (grant_id);
CREATE INDEX IF NOT EXISTS idx_ot_expires ON oauth_tokens (expires_at);

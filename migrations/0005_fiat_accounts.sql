-- Fase 17: fiat rail (Polar) — accounts + API keys + order idempotency.
--
-- Money stays in the EXISTING prepaid tables (balances/ledger/spend_nonces),
-- keyed by the synthetic address "acct:{account_id}". These tables only map
-- identity: who owns which key, and which Polar orders were already credited.

-- One account per customer email (Polar identity). Balance lives in
-- balances.address = 'acct:' || account_id — never here.
CREATE TABLE IF NOT EXISTS accounts (
  account_id        TEXT    PRIMARY KEY,      -- UUID
  email             TEXT    NOT NULL UNIQUE,  -- lowercase
  polar_customer_id TEXT,
  created_at        INTEGER NOT NULL          -- unix seconds
);

-- API keys. Only the SHA-256 hash of the key is stored; the plaintext key is
-- generated at claim time (/welcome) and never persisted. Revoking/rotating a
-- key never touches the account balance.
CREATE TABLE IF NOT EXISTS api_keys (
  key_id       TEXT    PRIMARY KEY,           -- short public id (analytics/portal)
  key_hash     TEXT    NOT NULL UNIQUE,       -- SHA-256 hex of the full key
  account_id   TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER                        -- NULL = active
);
CREATE INDEX IF NOT EXISTS idx_api_keys_account ON api_keys (account_id);

-- Idempotency guard for Polar credits: INSERT here BEFORE crediting. A replayed
-- webhook (or the webhook/welcome race) conflicts on the PK and is a no-op.
CREATE TABLE IF NOT EXISTS polar_orders (
  order_id     TEXT    PRIMARY KEY,           -- Polar order id
  account_id   TEXT    NOT NULL,
  amount_micro INTEGER NOT NULL,              -- gross amount credited (micro-USD)
  credited_at  INTEGER NOT NULL
);

-- One key claim per checkout: the key is shown exactly once. A second visit to
-- /welcome with the same checkout_id must never re-mint or re-show a key.
CREATE TABLE IF NOT EXISTS checkout_claims (
  checkout_id TEXT    PRIMARY KEY,            -- Polar checkout id
  account_id  TEXT    NOT NULL,
  key_id      TEXT,                           -- key minted for this claim (NULL = top-up, no key)
  claimed_at  INTEGER NOT NULL
);

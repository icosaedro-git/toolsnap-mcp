-- Fase 8 — Prepaid balances + append-only money ledger.
-- All monetary amounts are integers in micro-USDC (6 decimals); never floats.
-- D1/SQLite integers are 64-bit, far more than enough for micro-USDC.

-- Current spendable prepaid credit per payer address.
CREATE TABLE IF NOT EXISTS balances (
  address       TEXT    PRIMARY KEY,          -- lowercase 0x EVM address
  balance_micro INTEGER NOT NULL DEFAULT 0,   -- micro-USDC, always >= 0 (enforced by conditional debit)
  total_deposited_micro INTEGER NOT NULL DEFAULT 0, -- lifetime deposits (audit / analytics)
  total_spent_micro     INTEGER NOT NULL DEFAULT 0, -- lifetime debits (audit / analytics)
  created_at    INTEGER NOT NULL,             -- unix seconds
  updated_at    INTEGER NOT NULL,
  CHECK (balance_micro >= 0)
);

-- Append-only audit trail of every credit and debit. Source of truth for
-- disputes and Fase 9 analytics. The balances row is the source of truth for
-- money; this is the log.
CREATE TABLE IF NOT EXISTS ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  address       TEXT    NOT NULL,
  kind          TEXT    NOT NULL,             -- 'deposit' | 'debit'
  amount_micro  INTEGER NOT NULL,             -- positive for deposit, negative for debit
  balance_after INTEGER NOT NULL,             -- balance immediately after this entry
  tool          TEXT,                         -- tool name (debits only)
  tx_hash       TEXT,                         -- on-chain settle tx (deposits only)
  nonce         TEXT,                         -- x402 deposit nonce or spend-auth nonce
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_address ON ledger (address, created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_nonce   ON ledger (nonce);

-- Single-use spend-authorization nonces. PRIMARY KEY gives atomic, strongly
-- consistent replay protection in the SAME transactional domain as the debit:
-- a duplicate INSERT throws, so a concurrent replay of the same signed auth
-- cannot double-debit (the loser refunds). Kept in D1 (not KV) precisely so it
-- is consistent with the balance UPDATE; x402 deposit nonces stay in KV +
-- on-chain authorizationState (unchanged).
CREATE TABLE IF NOT EXISTS spend_nonces (
  nonce      TEXT    PRIMARY KEY,   -- 0x-prefixed bytes32 from the SpendAuthorization
  address    TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

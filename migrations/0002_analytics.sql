-- Fase 9: Analytics events table
-- Written by writeEvent() after every tools/call dispatch.
-- Queried by /analytics/data endpoint for the private dashboard.

CREATE TABLE IF NOT EXISTS analytics_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,         -- Unix epoch ms
  tool_name    TEXT    NOT NULL,
  payment_type TEXT    NOT NULL,
  payer        TEXT    NOT NULL,
  revenue_usdc REAL    NOT NULL DEFAULT 0,
  latency_ms   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ae_ts   ON analytics_events (ts DESC);
CREATE INDEX IF NOT EXISTS idx_ae_tool ON analytics_events (tool_name);
CREATE INDEX IF NOT EXISTS idx_ae_pay  ON analytics_events (payment_type);

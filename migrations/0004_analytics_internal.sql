-- Fase 19: distinguish internal (own dev/testing) traffic from real demand.
-- internal = 1 when the call carried a valid X-ToolSnap-Internal token,
-- used the admin bypass, or the payer is one of our own wallets (INTERNAL_WALLETS).
ALTER TABLE analytics_events ADD COLUMN internal INTEGER NOT NULL DEFAULT 0;

-- Retro-mark historical admin-bypass usage as internal.
UPDATE analytics_events SET internal = 1 WHERE payer = 'admin';

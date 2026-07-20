-- Fase 13.1 — fal.ai media tools: estimated COGS per analytics event, for
-- margin auditing (revenue_usdc already existed; cogs_usdc is new and only
-- populated for dynamically-priced tools — NULL for everything else).
ALTER TABLE analytics_events ADD COLUMN cogs_usdc REAL;

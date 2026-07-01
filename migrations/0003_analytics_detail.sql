-- Fase 14: error observability for analytics_events.
-- detail: human-readable reason for a failed/rejected event (error message, reject reason).
-- client: caller's User-Agent header — identifies which MCP client made the call.
ALTER TABLE analytics_events ADD COLUMN detail TEXT;
ALTER TABLE analytics_events ADD COLUMN client TEXT;

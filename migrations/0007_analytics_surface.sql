-- Fase 24: capture which MCP client/surface is calling (Claude Desktop,
-- Claude Code, mcp-remote, a bespoke script, ...) so we can measure which
-- surface converts, instead of only the raw User-Agent (already in `client`).
-- Populated from the `clientInfo` the client sends in the MCP `initialize`
-- request (persisted per-session in KV, see src/analytics/surface.ts) with a
-- User-Agent heuristic fallback for calls outside a tracked session.
ALTER TABLE analytics_events ADD COLUMN client_name TEXT;
ALTER TABLE analytics_events ADD COLUMN client_version TEXT;

-- Mcp-Session-Id of the call, when the transport provided one. Lets the panel
-- compute the CP-tarea-completa funnel (% of sessions that use >=3 tools of
-- the same family, nota 07) without linking to any human identity — session
-- ids are transport-level and ephemeral, not accounts/wallets/emails.
ALTER TABLE analytics_events ADD COLUMN session_id TEXT;

CREATE INDEX IF NOT EXISTS idx_ae_client_name ON analytics_events (client_name);
CREATE INDEX IF NOT EXISTS idx_ae_session ON analytics_events (session_id);

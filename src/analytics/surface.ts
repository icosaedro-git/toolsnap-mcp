/**
 * Client-surface resolution for analytics (Fase 24).
 *
 * MCP only sends `clientInfo` (name/version) once, in the `initialize`
 * request. To attribute later tool-calls in the same session to the right
 * surface (Claude Desktop, Claude Code, mcp-remote, a bespoke script, ...),
 * `initialize` persists it in KV keyed by `Mcp-Session-Id`, and every later
 * call in dispatch() reads it back. Sessionless calls (no session id, or the
 * KV entry expired) fall back to a coarse User-Agent heuristic.
 */

const SESSION_CLIENT_KEY_PREFIX = "session_client:";
const SESSION_CLIENT_TTL_SECONDS = 86_400; // 24h — matches session-scoped KV elsewhere in this codebase.

export interface ClientSurface {
  name: string | null;
  version: string | null;
}

export interface PersistedClientInfo {
  name?: string;
  version?: string;
}

/** Store the clientInfo the client just sent at `initialize`, for later calls in the same session. */
export async function persistSessionClient(
  kv: KVNamespace | undefined,
  sessionId: string,
  clientInfo: PersistedClientInfo
): Promise<void> {
  if (!kv || !sessionId || !clientInfo.name) return;
  await kv
    .put(`${SESSION_CLIENT_KEY_PREFIX}${sessionId}`, JSON.stringify(clientInfo), {
      expirationTtl: SESSION_CLIENT_TTL_SECONDS,
    })
    .catch(() => {
      // Analytics attribution must never break the request.
    });
}

/** Read back the clientInfo persisted for this session, if any. */
export async function readSessionClient(
  kv: KVNamespace | undefined,
  sessionId: string
): Promise<PersistedClientInfo | null> {
  if (!kv || !sessionId) return null;
  try {
    const raw = await kv.get(`${SESSION_CLIENT_KEY_PREFIX}${sessionId}`);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedClientInfo;
  } catch {
    return null;
  }
}

/**
 * Resolve a normalized client-surface label. Prefers the session's persisted
 * MCP `clientInfo`; falls back to a heuristic over the raw User-Agent header
 * when there's no session-level info (sessionless client, or expired entry).
 */
export function classifySurface(ua: string, persisted?: PersistedClientInfo | null): ClientSurface {
  if (persisted?.name) {
    return { name: persisted.name, version: persisted.version ?? null };
  }

  const lower = (ua ?? "").toLowerCase();
  if (!lower) return { name: null, version: null };

  // Ordered most-specific first: mcp-remote wraps Claude Desktop's own UA in
  // some setups, so check it before the generic "claude" match.
  if (lower.includes("mcp-remote")) return { name: "mcp-remote", version: null };
  if (lower.includes("claude-desktop")) return { name: "claude-desktop", version: null };
  if (lower.includes("claude-cli") || lower.includes("claude-code")) return { name: "claude-code", version: null };
  if (lower.includes("claude")) return { name: "claude", version: null };
  if (lower.includes("cursor")) return { name: "cursor", version: null };
  if (lower.includes("python-httpx") || lower.includes("python-requests")) return { name: "python-script", version: null };
  if (lower.includes("node")) return { name: "node-client", version: null };
  if (lower.includes("curl")) return { name: "curl", version: null };
  return { name: "unknown", version: null };
}

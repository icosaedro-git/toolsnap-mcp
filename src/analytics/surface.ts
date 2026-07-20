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

  // Fase 25.1 — last-resort fallback: extract a product/version token straight
  // from the raw UA (e.g. "Chiark/0.1 (agent quality index; chiark.ai)" ->
  // "Chiark/0.1") instead of giving up as "unknown". Runs on the *original*
  // (non-lowercased) UA so casing is preserved. Skips generic HTTP-library
  // prefixes already handled above or with no attribution value.
  const productMatch = /^([A-Za-z0-9][\w.-]{1,39})\/([\w.-]+)/.exec(ua);
  if (productMatch) {
    const token = productMatch[1];
    const tokenLower = token.toLowerCase();
    const genericPrefixes = ["mozilla", "python-httpx", "python-requests", "node", "curl", "undici", "ktor-client"];
    if (!genericPrefixes.includes(tokenLower)) {
      return { name: token, version: productMatch[2] };
    }
  }

  return { name: "unknown", version: null };
}

/**
 * Fase 24.6 — MCP directory/registry scrapers that connect and read the
 * catalog (`initialize` + `tools/list`/`tool_catalog`) but represent listing
 * discovery, not real agent demand. Identified by client_name from the
 * clientInfo they send at `initialize` (see 2026-07-16 analytics review).
 * Used to exclude this traffic from demand metrics and to report on it
 * separately as a "directory coverage" signal — it's a positive indicator
 * of listing health, not noise to discard.
 *
 * Refreshed 2026-07-18 (Fase 25.1) with ~14 additional scanners identified in
 * the 07-17 analytics review. Deliberately NOT added: "test", "python-script",
 * "mcp", "agent-lab" — those are generic SDK/library labels also used by real
 * human-driven clients, not scanner identities.
 */
export const PROBE_CLIENTS: ReadonlySet<string> = new Set([
  "glimind-probe",
  "smithery-probe",
  "glama",
  "agent-tools.cloud",
  "MCPScoringEngine",
  "MCPExplorerBot",
  "verifymcp-probe",
  "aisec-registry-probe",
  "ps-mcp-tools-probe",
  "ci-smoke",
  "ci-smoke-oauth",
  "Kai 9000",
  "mcpscan",
  "mcp-ledger-probe",
  "mcphq-probe",
  "prsm-mcp-graph",
  "mcp-rugpull-research",
  "otter",
  "acton-probe",
  "acton-skill-extractor",
  "tiza-search-prober",
  "agentage-mcp-catalog-health",
  "mcplookup.com-probe",
  "chiark-prober",
  "glama-mcp-inspector",
  "DeltaForsch",
]);

/**
 * Fase 25.2 (2026-07-20) — new scanners keep appearing weekly (DeltaForsch,
 * canopii-scanner, sasame-audit all showed up within 48h of the last list
 * refresh), so chasing exact names doesn't scale. These SQL LIKE patterns
 * (case-insensitive in SQLite for ASCII) catch the naming conventions
 * scanners overwhelmingly follow, alongside the exact-name list above.
 * Kept deliberately specific — no bare '%scan%' or '%bot%' — to avoid
 * misclassifying a real agent whose name merely contains those substrings.
 */
export const PROBE_NAME_PATTERNS: readonly string[] = [
  "%probe%",
  "%scanner%",
  "%crawler%",
  "%-audit",
  "%spider%",
];

const ANON_HASH_PREFIX = "anon:";
const ANON_HASH_HEX_LEN = 12;

/**
 * Fase 24.6 — every anonymous caller (no wallet/API key/OAuth) previously
 * logged as the literal string "anon", collapsing every distinct agent into
 * one payer for `unique_payers_30d` and any per-agent metric. Returns a
 * stable pseudonym `anon:<12 hex>` derived from a salted hash of the
 * caller's IP — enough to distinguish agents and measure retention without
 * storing the IP itself. Degrades to the plain "anon" literal when the salt
 * secret isn't configured, so logging never breaks on a missing optional
 * secret (same defensive pattern as ABUSE_RL/shouldAlert).
 */
export async function anonPayerId(salt: string | undefined, clientIp: string): Promise<string> {
  if (!salt || !clientIp || clientIp === "unknown") return "anon";
  try {
    const data = new TextEncoder().encode(`${clientIp}:${salt}`);
    const digest = await crypto.subtle.digest("SHA-256", data);
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return `${ANON_HASH_PREFIX}${hex.slice(0, ANON_HASH_HEX_LEN)}`;
  } catch {
    return "anon";
  }
}

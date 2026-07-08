/**
 * OAuth 2.1 Bearer access-token verification for the Resource Server
 * (mcp.toolsnap.app). Fase 26 — see ADR-001.
 *
 * Tokens are minted ONLY by the Authorization Server (portal.toolsnap.app,
 * repo toolsnap-portal). This module only reads oauth_tokens to verify a
 * presented access token — it never writes a token, code, or client row.
 *
 * Same hashing pattern as src/fiat/keys.ts: a 256-bit CSPRNG token isn't
 * brute-forceable, so an unsalted SHA-256 hash is safe and gives O(1) lookup
 * in the per-call hot path.
 */

/** Looks like one of our OAuth access tokens? (cheap pre-filter before hashing/DB) */
export function looksLikeOAuthToken(value: string): boolean {
  return /^oat_[0-9A-Za-z]{43}$/.test(value);
}

/** SHA-256 hex of the full token string. Identical algorithm to fiat/keys.ts hashKey. */
export async function hashToken(rawToken: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawToken));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface VerifiedOAuthToken {
  tokenId: string;
  accountId: string;
  grantId: string;
  clientId: string;
}

/**
 * Verify a presented OAuth access token: hash → lookup → active, unrevoked,
 * unexpired, kind='access'. Returns null for unknown/revoked/expired tokens
 * alike (don't leak existence).
 */
export async function verifyOAuthToken(
  db: D1Database,
  rawToken: string
): Promise<VerifiedOAuthToken | null> {
  if (!looksLikeOAuthToken(rawToken)) return null;
  const tokenHash = await hashToken(rawToken);
  const now = Math.floor(Date.now() / 1000);
  const row = await db
    .prepare(
      `SELECT token_id, account_id, grant_id, client_id
       FROM oauth_tokens
       WHERE token_hash = ? AND kind = 'access' AND revoked_at IS NULL AND expires_at > ?`
    )
    .bind(tokenHash, now)
    .first<{ token_id: string; account_id: string; grant_id: string; client_id: string }>();
  if (!row) return null;
  return {
    tokenId: row.token_id,
    accountId: row.account_id,
    grantId: row.grant_id,
    clientId: row.client_id,
  };
}

/** Best-effort last_used_at bump (fire-and-forget via ctx.waitUntil). Mirrors touchKey. */
export async function touchOAuthToken(db: D1Database, tokenId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare("UPDATE oauth_tokens SET last_used_at = ? WHERE token_id = ? AND kind = 'access'")
    .bind(now, tokenId)
    .run();
}

/**
 * API key issuance/verification for the fiat rail (Fase 17).
 *
 * Identity model: an API key belongs to an ACCOUNT (email, Polar identity).
 * The money lives in the existing prepaid tables under the synthetic address
 * `acct:{account_id}` — see prepaid.ts. Revoking or rotating a key never
 * touches the balance.
 *
 * Storage: only SHA-256(key) is persisted. A 256-bit CSPRNG token is not
 * brute-forceable, so an unsalted hash is safe and gives O(1) lookup in the
 * per-call hot path (no bcrypt cost per tool call).
 */

/** Synthetic prepaid address for an account. */
export function accountAddress(accountId: string): string {
  return `acct:${accountId}`;
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Generate a new API key: sk_live_/sk_test_ + 43 base62 chars (~256 bits). */
export function generateKey(env: { POLAR_ENV?: string }): string {
  const prefix = (env.POLAR_ENV ?? "production") === "sandbox" ? "sk_test_" : "sk_live_";
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += BASE62[b % 62];
  // 11 extra chars of entropy to compensate the tiny modulo bias + fixed length
  const extra = new Uint8Array(11);
  crypto.getRandomValues(extra);
  for (const b of extra) out += BASE62[b % 62];
  return prefix + out.slice(0, 43);
}

/** SHA-256 hex of the full key string. */
export async function hashKey(rawKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawKey));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Looks like one of our keys? (cheap pre-filter before hashing/DB) */
export function looksLikeApiKey(value: string): boolean {
  return /^sk_(live|test)_[0-9A-Za-z]{20,64}$/.test(value);
}

export interface IssuedKey {
  keyId: string;
  rawKey: string; // ONLY returned here — never persisted
}

/** Mint a new key for an account. Returns the plaintext exactly once. */
export async function issueKey(
  db: D1Database,
  accountId: string,
  env: { POLAR_ENV?: string }
): Promise<IssuedKey> {
  const rawKey = generateKey(env);
  const keyHash = await hashKey(rawKey);
  // Public short id: prefix of the hash (collision-checked by PK on insert).
  const keyId = keyHash.slice(0, 8);
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare("INSERT INTO api_keys (key_id, key_hash, account_id, created_at) VALUES (?, ?, ?, ?)")
    .bind(keyId, keyHash, accountId, now)
    .run();
  return { keyId, rawKey };
}

/** Revoke a key by its public id. Returns true if a live key was revoked. */
export async function revokeKey(db: D1Database, keyId: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const res = await db
    .prepare("UPDATE api_keys SET revoked_at = ? WHERE key_id = ? AND revoked_at IS NULL")
    .bind(now, keyId)
    .run();
  return res.meta.changes === 1;
}

export interface VerifiedKey {
  keyId: string;
  accountId: string;
}

/**
 * Verify a presented key: hash → lookup → not revoked.
 * Returns null for unknown AND revoked keys alike (don't leak existence).
 */
export async function verifyApiKey(db: D1Database, rawKey: string): Promise<VerifiedKey | null> {
  if (!looksLikeApiKey(rawKey)) return null;
  const keyHash = await hashKey(rawKey);
  const row = await db
    .prepare("SELECT key_id, account_id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL")
    .bind(keyHash)
    .first<{ key_id: string; account_id: string }>();
  if (!row) return null;
  return { keyId: row.key_id, accountId: row.account_id };
}

/** Best-effort last_used_at bump (fire-and-forget via ctx.waitUntil). */
export async function touchKey(db: D1Database, keyId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare("UPDATE api_keys SET last_used_at = ? WHERE key_id = ?")
    .bind(now, keyId)
    .run();
}

/** Does this account_id exist? (used to validate account_deposit's credit_to) */
export async function accountExists(db: D1Database, accountId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM accounts WHERE account_id = ?")
    .bind(accountId)
    .first();
  return Boolean(row);
}

/** Does the account have any active (non-revoked) key? */
export async function hasActiveKey(db: D1Database, accountId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM api_keys WHERE account_id = ? AND revoked_at IS NULL LIMIT 1")
    .bind(accountId)
    .first();
  return Boolean(row);
}

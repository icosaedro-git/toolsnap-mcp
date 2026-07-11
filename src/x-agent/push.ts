/**
 * Web Push (Fase 22.4) — desktop notifications for the panel, sent as an
 * empty-body "tickle": the push wakes the service worker, which fetches
 * `/x-agent/api/replies/pending` same-origin (the Access session cookie
 * travels with it) and shows the notification with real detail itself. This
 * sidesteps RFC 8291 payload encryption entirely — we only ever need the
 * VAPID-signed Authorization header, not an encrypted body.
 *
 * VAPID keys are stored as their raw base64url components (the same format
 * the browser's PushManager.subscribe({applicationServerKey}) call uses for
 * the public key), so importing them as a JWK needs no ASN.1/DER handling —
 * WebCrypto's ECDSA sign() already returns the raw (r||s) signature format
 * JWS ES256 requires, unlike Node's default DER output.
 */

export interface XPushEnv {
  VAPID_PUBLIC_KEY?: string; // base64url, uncompressed EC point (0x04 || x || y), 65 bytes
  VAPID_PRIVATE_KEY?: string; // base64url of the 32-byte 'd' scalar
}

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b64url.length / 4) * 4, "=");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array | ArrayBuffer): string {
  const arr = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeJson(obj: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(obj)));
}

async function importVapidPrivateKey(env: XPushEnv): Promise<CryptoKey> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) throw new Error("VAPID keys not configured");
  const pub = base64UrlToBytes(env.VAPID_PUBLIC_KEY);
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error("VAPID_PUBLIC_KEY must be an uncompressed P-256 point (65 bytes, starts with 0x04)");
  const x = pub.slice(1, 33);
  const y = pub.slice(33, 65);
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: bytesToBase64Url(x),
    y: bytesToBase64Url(y),
    d: env.VAPID_PRIVATE_KEY,
    ext: true,
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/** Build the `Authorization: vapid t=..., k=...` header for one push endpoint. */
async function buildVapidAuthHeader(env: XPushEnv, endpoint: string): Promise<string> {
  const key = await importVapidPrivateKey(env);
  const aud = new URL(endpoint).origin;
  const header = { typ: "JWT", alg: "ES256" };
  const payload = { aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "mailto:unai@toolsnap.app" };
  const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(payload)}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput) as BufferSource
  );
  const jwt = `${signingInput}.${bytesToBase64Url(signature)}`;
  return `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`;
}

/**
 * Send an empty-body tickle push to one subscription. Returns 'gone' if the
 * endpoint responded 404/410 (subscription expired/unsubscribed — the
 * caller should delete the row), 'ok' otherwise, 'error' on any other failure.
 */
export async function sendTicklePush(env: XPushEnv, sub: PushSubscriptionRow): Promise<"ok" | "gone" | "error"> {
  try {
    const authHeader = await buildVapidAuthHeader(env, sub.endpoint);
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: { TTL: "60", Authorization: authHeader, "Content-Length": "0" },
    });
    if (res.status === 404 || res.status === 410) return "gone";
    return res.ok ? "ok" : "error";
  } catch {
    return "error";
  }
}

/** Fan out a tickle push to every registered subscription, pruning any that come back gone. */
export async function notifyAllSubscriptions(env: XPushEnv, db: D1Database): Promise<{ sent: number; pruned: number }> {
  const rows = await db.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions").all<PushSubscriptionRow>();
  let sent = 0;
  let pruned = 0;
  for (const sub of rows.results ?? []) {
    const result = await sendTicklePush(env, sub);
    if (result === "ok") sent++;
    if (result === "gone") {
      await db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(sub.endpoint).run();
      pruned++;
    }
  }
  return { sent, pruned };
}

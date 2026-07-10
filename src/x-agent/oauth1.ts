/**
 * OAuth 1.0a request signing for the X API v2 (user-context auth).
 *
 * Chosen over OAuth2 user-context (Fase 22 design, D3): OAuth1.0a access
 * tokens issued via the classic 3-legged flow never expire — no refresh
 * token, no rotation, no single-use-reuse failure mode to handle in a
 * headless cron publisher. Trade-off: we sign every request ourselves
 * (HMAC-SHA1 via WebCrypto) instead of sending a bearer token.
 */

export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

// RFC 3986 percent-encoding — encodeURIComponent leaves !*'() unescaped,
// which OAuth1's signature base string requires to be escaped too.
export function percentEncode(input: string): string {
  return encodeURIComponent(input).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

async function hmacSha1Base64(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key) as BufferSource,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message) as BufferSource);
  let bin = "";
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  return btoa(bin);
}

function nonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build the `Authorization: OAuth ...` header for a request.
 *
 * `extraOAuthParams` are additional oauth_* protocol params (oauth_callback,
 * oauth_verifier) — they are included BOTH in the signature base string AND
 * in the Authorization header, because OAuth1.0a requires every signed
 * parameter to actually be transmitted. (Root cause of a real 401 hunt,
 * 2026-07-10: an earlier version signed these but only would have sent them
 * as query params — which the request never had — so X computed the
 * signature over a smaller param set and rejected with a generic
 * "Could not authenticate you".)
 *
 * The JSON body of v2 write endpoints is excluded from the signature by
 * spec, so it needs no handling here. `queryParams` (added Fase 22.3 for the
 * metrics GET, the first caller to ever need a query string) is the
 * exception: OAuth1.0a requires every actual URL query parameter to be
 * folded into the signature base string alongside the oauth_* params — pass
 * the exact same key/value pairs here that you append to `url`'s query
 * string, so the two agree. They are NOT added to the Authorization header
 * (only oauth_* params + the signature go there).
 */
export async function signOAuth1(
  method: "GET" | "POST",
  url: string,
  creds: OAuth1Credentials,
  extraOAuthParams: Record<string, string> = {},
  queryParams: Record<string, string> = {}
): Promise<string> {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: nonce(),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: "1.0",
  };
  // oauth_token must be OMITTED (not sent as an empty string) when there is
  // no token yet — the request_token step (getRequestToken) signs with
  // accessToken="" precisely because no token exists. Including
  // oauth_token="" in the signature base string desyncs it from what the
  // server computes and fails with a generic 401 "Could not authenticate
  // you" (found the hard way: 2026-07-09, this path was only ever exercised
  // under X_DRY_RUN=1 before, which never actually calls the X API).
  if (creds.accessToken) {
    oauthParams.oauth_token = creds.accessToken;
  }
  Object.assign(oauthParams, extraOAuthParams);

  const allParams: Record<string, string> = { ...oauthParams, ...queryParams };
  const paramString = Object.keys(allParams)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(allParams[k])}`)
    .join("&");

  const baseUrl = url.split("?")[0];
  const baseString = [method, percentEncode(baseUrl), percentEncode(paramString)].join("&");
  const signingKey = `${percentEncode(creds.consumerSecret)}&${percentEncode(creds.accessTokenSecret)}`;
  const signature = await hmacSha1Base64(signingKey, baseString);

  const headerParams: Record<string, string> = { ...oauthParams, oauth_signature: signature };
  const header =
    "OAuth " +
    Object.keys(headerParams)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(headerParams[k])}"`)
      .join(", ");
  return header;
}

// ---------------------------------------------------------------------------
// PIN-based 3-legged flow (used once per account by scripts/x-authorize.mts
// to mint the long-lived access token + secret; never runs in the Worker).
// ---------------------------------------------------------------------------

function parseFormUrlEncoded(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of body.split("&")) {
    const [k, v] = pair.split("=");
    if (k) out[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
  }
  return out;
}

/** Step 1: obtain a request token (PIN-based, oauth_callback=oob). */
export async function getRequestToken(
  consumerKey: string,
  consumerSecret: string
): Promise<{ oauthToken: string; oauthTokenSecret: string }> {
  const url = "https://api.x.com/oauth/request_token";
  const header = await signOAuth1("POST", url, {
    consumerKey,
    consumerSecret,
    accessToken: "",
    accessTokenSecret: "",
  }, { oauth_callback: "oob" });
  const res = await fetch(url, { method: "POST", headers: { Authorization: header } });
  const text = await res.text();
  if (!res.ok) {
    const serverDate = res.headers.get("date");
    const skewNote = serverDate
      ? ` | X server date: ${serverDate} | local date: ${new Date().toUTCString()} | skew: ${Math.round(
          (Date.now() - new Date(serverDate).getTime()) / 1000
        )}s`
      : " | (X did not send a Date header — cannot check clock skew this way)";
    throw new Error(`request_token failed (${res.status}): ${text}${skewNote}`);
  }
  const parsed = parseFormUrlEncoded(text);
  if (!parsed.oauth_token || !parsed.oauth_token_secret) {
    throw new Error(`request_token response missing fields: ${text}`);
  }
  return { oauthToken: parsed.oauth_token, oauthTokenSecret: parsed.oauth_token_secret };
}

/** Step 2 (after the user authorizes in browser and types the PIN): exchange for a long-lived access token. */
export async function getAccessToken(
  consumerKey: string,
  consumerSecret: string,
  requestToken: string,
  requestTokenSecret: string,
  pin: string
): Promise<{ accessToken: string; accessTokenSecret: string; screenName: string; userId: string }> {
  const url = "https://api.x.com/oauth/access_token";
  const header = await signOAuth1("POST", url, {
    consumerKey,
    consumerSecret,
    accessToken: requestToken,
    accessTokenSecret: requestTokenSecret,
  }, { oauth_verifier: pin });
  const res = await fetch(url, { method: "POST", headers: { Authorization: header } });
  const text = await res.text();
  if (!res.ok) throw new Error(`access_token exchange failed (${res.status}): ${text}`);
  const parsed = parseFormUrlEncoded(text);
  if (!parsed.oauth_token || !parsed.oauth_token_secret) {
    throw new Error(`access_token response missing fields: ${text}`);
  }
  return {
    accessToken: parsed.oauth_token,
    accessTokenSecret: parsed.oauth_token_secret,
    screenName: parsed.screen_name ?? "",
    userId: parsed.user_id ?? "",
  };
}

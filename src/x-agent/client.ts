/**
 * X API v2 client — publishing only (POST /2/tweets). Two accounts
 * ("product" = @ToolSnapMCP, "personal" = @icosaedro_one), each with its own
 * OAuth1.0a access token/secret sharing one app (consumer key/secret).
 */

import { signOAuth1, type OAuth1Credentials } from "./oauth1.js";

export type XAccount = "product" | "personal";

export interface XAgentEnv {
  X_API_KEY?: string;
  X_API_SECRET?: string;
  X_ACCESS_TOKEN_PRODUCT?: string;
  X_ACCESS_TOKEN_SECRET_PRODUCT?: string;
  X_ACCESS_TOKEN_PERSONAL?: string;
  X_ACCESS_TOKEN_SECRET_PERSONAL?: string;
  // Numeric X user ids, captured once from scripts/x-authorize.mts' PIN-flow
  // output — needed for POST /2/users/:id/retweets (native repost, kind='repost').
  X_USER_ID_PRODUCT?: string;
  X_USER_ID_PERSONAL?: string;
  X_DRY_RUN?: string; // "1" -> log instead of calling the real API (local/e2e testing)
}

function credsForAccount(env: XAgentEnv, account: XAccount): OAuth1Credentials {
  const consumerKey = env.X_API_KEY;
  const consumerSecret = env.X_API_SECRET;
  const accessToken = account === "product" ? env.X_ACCESS_TOKEN_PRODUCT : env.X_ACCESS_TOKEN_PERSONAL;
  const accessTokenSecret =
    account === "product" ? env.X_ACCESS_TOKEN_SECRET_PRODUCT : env.X_ACCESS_TOKEN_SECRET_PERSONAL;
  if (!consumerKey || !consumerSecret || !accessToken || !accessTokenSecret) {
    throw new Error(`X credentials not configured for account "${account}"`);
  }
  return { consumerKey, consumerSecret, accessToken, accessTokenSecret };
}

export interface PublishParams {
  account: XAccount;
  text?: string;
  quoteTweetId?: string;
  replyToTweetId?: string;
  mediaIds?: string[];
}

export interface PublishResult {
  tweetId: string;
}

export class XApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = "XApiError";
  }
}

/**
 * Publish one post via POST /2/tweets. Throws XApiError; `retryable` is true
 * for 429/5xx/network failures, false for 4xx content errors (duplicate,
 * length, invalid quote/reply target) that a retry can never fix.
 */
export async function publishTweet(env: XAgentEnv, params: PublishParams): Promise<PublishResult> {
  const url = "https://api.x.com/2/tweets";

  const body: Record<string, unknown> = {};
  if (params.text) body.text = params.text;
  if (params.quoteTweetId) body.quote_tweet_id = params.quoteTweetId;
  if (params.replyToTweetId) body.reply = { in_reply_to_tweet_id: params.replyToTweetId };
  if (params.mediaIds?.length) body.media = { media_ids: params.mediaIds };

  if (env.X_DRY_RUN === "1") {
    const fakeId = `dryrun_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    console.log(`[x-agent DRY_RUN] would POST /2/tweets as ${params.account}:`, JSON.stringify(body));
    return { tweetId: fakeId };
  }

  const creds = credsForAccount(env, params.account);
  const authHeader = await signOAuth1("POST", url, creds);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw new XApiError(`X API error (${res.status}): ${text.slice(0, 500)}`, res.status, retryable);
  }

  let parsed: { data?: { id?: string } };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new XApiError(`X API returned non-JSON success body: ${text.slice(0, 200)}`, res.status, false);
  }
  const tweetId = parsed.data?.id;
  if (!tweetId) {
    throw new XApiError(`X API success response missing data.id: ${text.slice(0, 200)}`, res.status, false);
  }
  return { tweetId };
}

/**
 * Upload one image (INIT/APPEND/FINALIZE against POST /2/media/upload,
 * media_category=tweet_image) and return the resulting media id for
 * PublishParams.mediaIds. Images are capped at 5MB (panel/queue.ts
 * enforce this on ingest) so a single APPEND chunk always suffices —
 * no need for the multi-segment loop chunked video uploads require.
 *
 * X's public docs for this endpoint only show OAuth2 Bearer / a generic
 * "UserToken" HTTP-OAuth scheme, not OAuth1.0a explicitly — but every other
 * v2 write endpoint this codebase calls (POST /2/tweets, POST
 * /2/users/:id/retweets) accepts the same OAuth1.0a User Context signing
 * and works in production, so this reuses signOAuth1 rather than adding a
 * second auth path. If this ever 401s in practice (verify on first real
 * image post), that's the first thing to check.
 */
export async function uploadMedia(env: XAgentEnv, account: XAccount, bytes: Uint8Array, mimeType: string): Promise<string> {
  const url = "https://api.x.com/2/media/upload";

  if (env.X_DRY_RUN === "1") {
    const fakeId = `dryrun_media_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    console.log(`[x-agent DRY_RUN] would upload media (${bytes.length} bytes, ${mimeType}) as ${account}`);
    return fakeId;
  }

  const creds = credsForAccount(env, account);

  async function call(form: FormData): Promise<{ ok: boolean; status: number; text: string }> {
    const authHeader = await signOAuth1("POST", url, creds);
    const res = await fetch(url, { method: "POST", headers: { Authorization: authHeader }, body: form });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  }

  const initForm = new FormData();
  initForm.set("command", "INIT");
  initForm.set("media_type", mimeType);
  initForm.set("total_bytes", String(bytes.length));
  initForm.set("media_category", "tweet_image");
  const initRes = await call(initForm);
  if (!initRes.ok) {
    const retryable = initRes.status === 429 || initRes.status >= 500;
    throw new XApiError(`media INIT failed (${initRes.status}): ${initRes.text.slice(0, 500)}`, initRes.status, retryable);
  }
  let mediaId: string | undefined;
  try {
    mediaId = (JSON.parse(initRes.text) as { data?: { id?: string } }).data?.id;
  } catch {
    // fall through to the missing-id check below
  }
  if (!mediaId) {
    throw new XApiError(`media INIT response missing data.id: ${initRes.text.slice(0, 200)}`, initRes.status, false);
  }

  const appendForm = new FormData();
  appendForm.set("command", "APPEND");
  appendForm.set("media_id", mediaId);
  appendForm.set("segment_index", "0");
  appendForm.set("media", new Blob([bytes as unknown as BlobPart], { type: mimeType }));
  const appendRes = await call(appendForm);
  if (!appendRes.ok) {
    const retryable = appendRes.status === 429 || appendRes.status >= 500;
    throw new XApiError(`media APPEND failed (${appendRes.status}): ${appendRes.text.slice(0, 500)}`, appendRes.status, retryable);
  }

  const finalizeForm = new FormData();
  finalizeForm.set("command", "FINALIZE");
  finalizeForm.set("media_id", mediaId);
  const finalizeRes = await call(finalizeForm);
  if (!finalizeRes.ok) {
    const retryable = finalizeRes.status === 429 || finalizeRes.status >= 500;
    throw new XApiError(`media FINALIZE failed (${finalizeRes.status}): ${finalizeRes.text.slice(0, 500)}`, finalizeRes.status, retryable);
  }

  return mediaId;
}

export interface TweetMetrics {
  tweetId: string;
  impressions: number | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  quotes: number | null;
  bookmarks: number | null;
}

/**
 * Fetch public_metrics for up to 100 tweet ids in one call (GET /2/tweets),
 * feeding x_metrics (Fase 22.3). Always uses the "product" account's
 * credentials — this reads metrics for tweets from BOTH accounts (they're
 * our own public tweets, any authenticated app context can read them), so
 * one credential set is enough rather than splitting the call per account.
 */
export async function fetchTweetMetrics(env: XAgentEnv, ids: string[]): Promise<TweetMetrics[]> {
  if (ids.length === 0) return [];
  if (ids.length > 100) throw new Error("fetchTweetMetrics: max 100 ids per call (X API limit)");

  if (env.X_DRY_RUN === "1") {
    console.log(`[x-agent DRY_RUN] would GET /2/tweets public_metrics for ${ids.length} id(s)`);
    return ids.map((id) => ({ tweetId: id, impressions: 0, likes: 0, replies: 0, reposts: 0, quotes: 0, bookmarks: 0 }));
  }

  const baseUrl = "https://api.x.com/2/tweets";
  const queryParams = { ids: ids.join(","), "tweet.fields": "public_metrics" };
  const url = `${baseUrl}?${new URLSearchParams(queryParams).toString()}`;

  const creds = credsForAccount(env, "product");
  const authHeader = await signOAuth1("GET", baseUrl, creds, {}, queryParams);

  const res = await fetch(url, { method: "GET", headers: { Authorization: authHeader } });
  const text = await res.text();
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw new XApiError(`X API metrics error (${res.status}): ${text.slice(0, 500)}`, res.status, retryable);
  }

  let parsed: { data?: Array<{ id: string; public_metrics?: Record<string, number> }> };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new XApiError(`X API metrics returned non-JSON body: ${text.slice(0, 200)}`, res.status, false);
  }

  return (parsed.data ?? []).map((t) => ({
    tweetId: t.id,
    impressions: t.public_metrics?.impression_count ?? null,
    likes: t.public_metrics?.like_count ?? null,
    replies: t.public_metrics?.reply_count ?? null,
    reposts: t.public_metrics?.retweet_count ?? null,
    quotes: t.public_metrics?.quote_count ?? null,
    bookmarks: t.public_metrics?.bookmark_count ?? null,
  }));
}

/**
 * Native repost (retweet) via POST /2/users/:id/retweets — no text, distinct
 * from a quote-post. Returns the ORIGINAL tweet id (X's retweet response has
 * no id of its own for the retweet action itself).
 */
export async function repostTweet(env: XAgentEnv, account: XAccount, targetTweetId: string): Promise<PublishResult> {
  const userId = account === "product" ? env.X_USER_ID_PRODUCT : env.X_USER_ID_PERSONAL;
  if (!userId) throw new Error(`X user id not configured for account "${account}" (X_USER_ID_${account.toUpperCase()})`);
  const url = `https://api.x.com/2/users/${userId}/retweets`;

  if (env.X_DRY_RUN === "1") {
    console.log(`[x-agent DRY_RUN] would POST ${url} as ${account}: retweet ${targetTweetId}`);
    return { tweetId: targetTweetId };
  }

  const creds = credsForAccount(env, account);
  const authHeader = await signOAuth1("POST", url, creds);
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
    body: JSON.stringify({ tweet_id: targetTweetId }),
  });
  const text = await res.text();
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw new XApiError(`X API retweet error (${res.status}): ${text.slice(0, 500)}`, res.status, retryable);
  }
  return { tweetId: targetTweetId };
}

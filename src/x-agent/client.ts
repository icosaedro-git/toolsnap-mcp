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
  const url = "https://api.twitter.com/2/tweets";

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
 * Native repost (retweet) via POST /2/users/:id/retweets — no text, distinct
 * from a quote-post. Returns the ORIGINAL tweet id (X's retweet response has
 * no id of its own for the retweet action itself).
 */
export async function repostTweet(env: XAgentEnv, account: XAccount, targetTweetId: string): Promise<PublishResult> {
  const userId = account === "product" ? env.X_USER_ID_PRODUCT : env.X_USER_ID_PERSONAL;
  if (!userId) throw new Error(`X user id not configured for account "${account}" (X_USER_ID_${account.toUpperCase()})`);
  const url = `https://api.twitter.com/2/users/${userId}/retweets`;

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

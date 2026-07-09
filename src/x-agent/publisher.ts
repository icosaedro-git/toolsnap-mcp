/**
 * Publisher cron (Fase 22.1) — runs every 5 minutes, picks up due `scheduled`
 * rows (respecting depends_on/min_gap_s ordering for quotes/replies/threads),
 * claims each atomically, and publishes it via the X API.
 */

import { publishTweet, repostTweet, XApiError, type XAgentEnv } from "./client.js";
import type { XTelegramEnv } from "./telegram.js";
import { sendXAgentMessage } from "./telegram.js";
import { claimForPublishing, getDueRows, getQueueRow, markFailedOrRetry, markPublished, type XQueueRow } from "./queue.js";

export interface XPublisherEnv extends XAgentEnv, XTelegramEnv {
  PREPAID_DB: D1Database;
}

/** Run one publisher tick: attempt every currently-eligible row once. */
export async function runXPublisher(env: XPublisherEnv): Promise<{ attempted: number; published: number; failed: number }> {
  const db = env.PREPAID_DB;
  const due = await getDueRows(db, 10);
  let published = 0;
  let failed = 0;

  for (const row of due) {
    const claimed = await claimForPublishing(db, row.id);
    if (!claimed) continue; // another cron tick (or overlap) already took it

    try {
      const result = await publishOne(env, row, db);
      await markPublished(db, row.id, result.tweetId);
      published++;
    } catch (err) {
      const retryable = err instanceof XApiError ? err.retryable : true;
      const message = err instanceof Error ? err.message : String(err);
      const { willRetry } = await markFailedOrRetry(db, row.id, message, retryable);
      failed++;
      if (!willRetry) {
        await sendXAgentMessage(
          env,
          `⚠️ *Fallo publicando #${row.id}* (${row.account})\n\n${message.slice(0, 300)}\n\nEstado: failed. Hijos dependientes bloqueados.`
        );
      }
    }
  }

  return { attempted: due.length, published, failed };
}

/**
 * Resolve the target tweet id for internal quote/reply chaining: if the row
 * has no explicit external `quote_tweet_id`/`reply_to_tweet_id` but does have
 * a `depends_on` parent (already guaranteed published by getDueRows's join),
 * use the parent's own tweet_id as the target.
 */
async function publishOne(env: XAgentEnv, row: XQueueRow, db: D1Database): Promise<{ tweetId: string }> {
  let quoteTweetId = row.quote_tweet_id ?? undefined;
  let replyToTweetId = row.reply_to_tweet_id ?? undefined;
  let parentTweetId: string | undefined;

  if (row.depends_on) {
    const parent = await getQueueRow(db, row.depends_on);
    if (!parent?.tweet_id) {
      throw new XApiError(`parent #${row.depends_on} has no tweet_id yet (should not happen — getDueRows guards this)`, 0, false);
    }
    parentTweetId = parent.tweet_id;
    if (!quoteTweetId && !replyToTweetId) {
      if (row.kind === "quote") quoteTweetId = parentTweetId;
      else if (row.kind === "reply" || row.kind === "thread_part") replyToTweetId = parentTweetId;
    }
  }

  if (row.kind === "repost") {
    const targetId = row.quote_tweet_id ?? parentTweetId;
    if (!targetId) throw new XApiError(`repost row #${row.id} has no target tweet id (quote_tweet_id or depends_on)`, 0, false);
    return repostTweet(env, row.account, targetId);
  }

  return publishTweet(env, {
    account: row.account,
    text: row.text ?? undefined,
    quoteTweetId,
    replyToTweetId,
  });
}

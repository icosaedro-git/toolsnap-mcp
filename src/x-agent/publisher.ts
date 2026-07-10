/**
 * Publisher cron (Fase 22.1) — runs every 5 minutes, picks up due `scheduled`
 * rows (respecting depends_on/min_gap_s ordering for quotes/replies/threads),
 * claims each atomically, and publishes it via the X API.
 */

import { publishTweet, repostTweet, XApiError, type XAgentEnv } from "./client.js";
import type { XTelegramEnv } from "./telegram.js";
import { sendXAgentMessage } from "./telegram.js";
import { formatCard } from "./telegram-approval.js";
import {
  claimForPublishing,
  getDueRows,
  getQueueRow,
  getVetoRowsNeedingNotice,
  markFailedOrRetry,
  markPublished,
  markVetoNotified,
  type XQueueRow,
} from "./queue.js";

export interface XPublisherEnv extends XAgentEnv, XTelegramEnv {
  PREPAID_DB: D1Database;
  // Fase 22.2 — L2 veto window. Defaults chosen with Unai 2026-07-10: 4h
  // notice, 30min minimum gap between notice and publish.
  X_VETO_NOTICE_S?: string;
  X_VETO_MIN_S?: string;
}

const DEFAULT_VETO_NOTICE_S = 4 * 3600;
const DEFAULT_VETO_MIN_S = 30 * 60;

/**
 * True during Unai's requested quiet hours (00:00-12:00 Europe/Madrid) — the
 * publisher defers sending new veto notices during this window so he never
 * wakes up to a cancel-window Telegram card. Rows already past their notice
 * are unaffected; this only gates *sending new notices*, never publishing
 * (a row notified before quiet hours started still publishes on schedule).
 */
function isMadridQuietHours(date: Date): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "numeric", hourCycle: "h23" }).format(date)
  );
  return hour >= 0 && hour < 12;
}

/**
 * Send cancel-window notices for any `veto` row entering its notice window,
 * unless we're inside Madrid quiet hours (00:00-12:00) — those are retried
 * on every subsequent tick until quiet hours end.
 */
async function sendVetoNotices(env: XPublisherEnv, db: D1Database): Promise<void> {
  // Quiet hours are a real-wall-clock concern; skip the gate under
  // X_DRY_RUN (local/e2e testing, scripts/x-agent-test.mts) so tests are
  // deterministic regardless of what time they happen to run.
  if (env.X_DRY_RUN !== "1" && isMadridQuietHours(new Date())) return;
  const noticeS = Number(env.X_VETO_NOTICE_S) || DEFAULT_VETO_NOTICE_S;
  const rows = await getVetoRowsNeedingNotice(db, noticeS);
  for (const row of rows) {
    const when = row.scheduled_at ? new Date(row.scheduled_at * 1000).toISOString() : "sin hora";
    const text = `${formatCard(row)}\n\n⏳ *Se publicará solo a las ${when} salvo veto.*`;
    const messageId = await sendXAgentMessage(env, text, {
      inlineKeyboard: [[{ text: "🚫 Cancelar", callback_data: `xq:${row.id}:cancel` }]],
    });
    await markVetoNotified(db, row.id, messageId);
  }
}

/** Run one publisher tick: send due veto notices, then attempt every currently-eligible row once. */
export async function runXPublisher(env: XPublisherEnv): Promise<{ attempted: number; published: number; failed: number }> {
  const db = env.PREPAID_DB;
  await sendVetoNotices(env, db);
  const vetoMinS = Number(env.X_VETO_MIN_S) || DEFAULT_VETO_MIN_S;
  const due = await getDueRows(db, 10, vetoMinS);
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

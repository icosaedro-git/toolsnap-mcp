/**
 * Shared D1 access for the x_queue content queue — used by the publisher
 * cron, the Telegram approval webhook, and the /admin/x/* endpoints.
 */

export type XQueueStatus =
  | "draft"
  | "pending_approval"
  | "scheduled"
  | "publishing"
  | "published"
  | "rejected"
  | "canceled"
  | "blocked"
  | "failed";

export type XApprovalMode = "per_post" | "batch" | "veto" | "auto";

export interface XQueueRow {
  id: number;
  account: "product" | "personal";
  kind: "post" | "quote" | "reply" | "thread_part" | "repost";
  text: string | null;
  media_keys: string | null;
  depends_on: number | null;
  min_gap_s: number;
  quote_tweet_id: string | null;
  reply_to_tweet_id: string | null;
  series: string | null;
  batch_id: string | null;
  status: XQueueStatus;
  scheduled_at: number | null;
  approval_mode: XApprovalMode;
  veto_notified_at: number | null;
  tg_message_id: number | null;
  tweet_id: string | null;
  published_at: number | null;
  error: string | null;
  attempt_count: number;
  created_at: number;
  updated_at: number | null;
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

export async function getQueueRow(db: D1Database, id: number): Promise<XQueueRow | null> {
  return db.prepare("SELECT * FROM x_queue WHERE id = ?").bind(id).first<XQueueRow>();
}

/** Approve a pending_approval row -> scheduled. No-op (false) if not currently pending_approval. */
export async function approveRow(db: D1Database, id: number): Promise<boolean> {
  const res = await db
    .prepare("UPDATE x_queue SET status = 'scheduled', updated_at = ? WHERE id = ? AND status = 'pending_approval'")
    .bind(now(), id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** Reject a pending_approval row, log the correction, and block any children waiting on it. */
export async function rejectRow(db: D1Database, id: number): Promise<boolean> {
  const row = await getQueueRow(db, id);
  if (!row || row.status !== "pending_approval") return false;
  const res = await db
    .prepare("UPDATE x_queue SET status = 'rejected', updated_at = ? WHERE id = ? AND status = 'pending_approval'")
    .bind(now(), id)
    .run();
  const changed = (res.meta.changes ?? 0) > 0;
  if (changed) {
    await db
      .prepare(
        "INSERT INTO x_corrections (queue_id, original_text, final_text, source, created_at) VALUES (?, ?, '', 'telegram_reject', ?)"
      )
      .bind(id, row.text ?? "", now())
      .run();
    await blockChildren(db, id);
  }
  return changed;
}

/** Edit the text of a pending_approval row, record the correction, and approve it. */
export async function editAndApproveRow(db: D1Database, id: number, newText: string): Promise<boolean> {
  const row = await getQueueRow(db, id);
  if (!row || row.status !== "pending_approval") return false;
  await db
    .prepare(
      "INSERT INTO x_corrections (queue_id, original_text, final_text, source, created_at) VALUES (?, ?, ?, 'telegram_edit', ?)"
    )
    .bind(id, row.text ?? "", newText, now())
    .run();
  const res = await db
    .prepare("UPDATE x_queue SET text = ?, status = 'scheduled', updated_at = ? WHERE id = ? AND status = 'pending_approval'")
    .bind(newText, now(), id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** Cancel a scheduled row (veto window / manual cancel from the panel). */
export async function cancelRow(db: D1Database, id: number): Promise<boolean> {
  const res = await db
    .prepare("UPDATE x_queue SET status = 'canceled', updated_at = ? WHERE id = ? AND status IN ('scheduled', 'pending_approval')")
    .bind(now(), id)
    .run();
  const changed = (res.meta.changes ?? 0) > 0;
  if (changed) await blockChildren(db, id);
  return changed;
}

/** Mark any not-yet-published children of `parentId` as blocked (parent failed/rejected/canceled). */
export async function blockChildren(db: D1Database, parentId: number): Promise<void> {
  await db
    .prepare(
      "UPDATE x_queue SET status = 'blocked', updated_at = ? WHERE depends_on = ? AND status IN ('draft', 'pending_approval', 'scheduled')"
    )
    .bind(now(), parentId)
    .run();
}

/**
 * Rows the publisher cron should attempt right now: scheduled, due, and
 * either no parent or a parent that has published at least min_gap_s ago.
 * `veto` rows have one extra gate: they must have had their veto-window
 * notice sent at least `vetoMinS` ago (see markVetoNotified / the Fase 22.2
 * notice-sending step in publisher.ts) — this is what gives Unai a real
 * cancel window even for rows loaded with little lead time before scheduled_at.
 */
export async function getDueRows(db: D1Database, limit = 10, vetoMinS = 1800): Promise<XQueueRow[]> {
  const nowTs = now();
  const res = await db
    .prepare(
      `SELECT q.* FROM x_queue q
       LEFT JOIN x_queue p ON p.id = q.depends_on
       WHERE q.status = 'scheduled'
         AND q.scheduled_at IS NOT NULL
         AND q.scheduled_at <= ?
         AND (
           q.depends_on IS NULL
           OR (p.status = 'published' AND p.published_at IS NOT NULL AND p.published_at + q.min_gap_s <= ?)
         )
         AND (
           q.approval_mode != 'veto'
           OR (q.veto_notified_at IS NOT NULL AND q.veto_notified_at + ? <= ?)
         )
       ORDER BY q.scheduled_at ASC
       LIMIT ?`
    )
    .bind(nowTs, nowTs, vetoMinS, nowTs, limit)
    .all<XQueueRow>();
  return res.results ?? [];
}

/**
 * `veto` rows that are due soon and haven't had their cancel-window notice
 * sent yet. `noticeS` is how far ahead of scheduled_at the notice should go
 * out (e.g. 4h) — checked separately from the publish gate in getDueRows so
 * the notice fires well before the row would otherwise become eligible.
 */
export async function getVetoRowsNeedingNotice(db: D1Database, noticeS: number, limit = 20): Promise<XQueueRow[]> {
  const nowTs = now();
  const res = await db
    .prepare(
      `SELECT * FROM x_queue
       WHERE status = 'scheduled'
         AND approval_mode = 'veto'
         AND veto_notified_at IS NULL
         AND scheduled_at IS NOT NULL
         AND scheduled_at - ? <= ?
       ORDER BY scheduled_at ASC
       LIMIT ?`
    )
    .bind(noticeS, nowTs, limit)
    .all<XQueueRow>();
  return res.results ?? [];
}

/** Record that the veto-window Telegram notice was sent for this row. */
export async function markVetoNotified(db: D1Database, id: number, tgMessageId: number | null): Promise<void> {
  await db
    .prepare("UPDATE x_queue SET veto_notified_at = ?, tg_message_id = ?, updated_at = ? WHERE id = ?")
    .bind(now(), tgMessageId, now(), id)
    .run();
}

/** Atomically claim a row for publishing — returns false if another cron run already claimed it. */
export async function claimForPublishing(db: D1Database, id: number): Promise<boolean> {
  const res = await db
    .prepare("UPDATE x_queue SET status = 'publishing', updated_at = ? WHERE id = ? AND status = 'scheduled'")
    .bind(now(), id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function markPublished(db: D1Database, id: number, tweetId: string): Promise<void> {
  const ts = now();
  await db
    .prepare("UPDATE x_queue SET status = 'published', tweet_id = ?, published_at = ?, updated_at = ? WHERE id = ?")
    .bind(tweetId, ts, ts, id)
    .run();
}

/** Publishing failed. Retryable errors go back to 'scheduled' (re-attempted next cron tick, up to 3 tries); non-retryable or exhausted go to 'failed' (and block children). */
export async function markFailedOrRetry(
  db: D1Database,
  id: number,
  errorMessage: string,
  retryable: boolean,
  maxAttempts = 3
): Promise<{ willRetry: boolean }> {
  const row = await getQueueRow(db, id);
  const attemptCount = (row?.attempt_count ?? 0) + 1;
  const willRetry = retryable && attemptCount < maxAttempts;
  await db
    .prepare(
      `UPDATE x_queue SET status = ?, error = ?, attempt_count = ?, updated_at = ?
       WHERE id = ?`
    )
    .bind(willRetry ? "scheduled" : "failed", errorMessage.slice(0, 1000), attemptCount, now(), id)
    .run();
  if (!willRetry) await blockChildren(db, id);
  return { willRetry };
}

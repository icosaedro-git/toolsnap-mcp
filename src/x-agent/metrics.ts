/**
 * Fase 22.3 — daily engagement metrics fetch. Hangs off the existing daily
 * cron (the "0 9 * * *" branch in scheduled(), not the every-5-minute
 * publisher branch) rather than adding a third Cron Trigger — engagement
 * numbers change slowly, no reason to poll more than once a day. Fills
 * x_metrics (present since the Fase 22.1
 * migration, unused until now) via an upsert keyed on tweet_id: each run
 * overwrites with the latest snapshot rather than keeping a history.
 *
 * Covers rows published either by the API or manually-with-a-link
 * (getRecentPublishedRowsWithTweetId already excludes dry-run fake ids and
 * manual rows with no tweet_id).
 */
import { fetchTweetMetrics, type XAgentEnv } from "./client.js";
import { getRecentPublishedRowsWithTweetId } from "./queue.js";

export interface XMetricsEnv extends XAgentEnv {
  PREPAID_DB: D1Database;
  // How many days back to look for published rows worth re-measuring.
  // Kept as a dial (not hardcoded) because each read costs money ($0.005,
  // capped at 2M/month) — lower it if the X API bill needs trimming.
  X_METRICS_WINDOW_D?: string;
}

const DEFAULT_WINDOW_D = 14;

export async function fetchXMetrics(env: XMetricsEnv): Promise<{ fetched: number; upserted: number }> {
  const db = env.PREPAID_DB;
  const windowD = Number(env.X_METRICS_WINDOW_D) || DEFAULT_WINDOW_D;
  const sinceTs = Math.floor(Date.now() / 1000) - windowD * 86400;

  const rows = await getRecentPublishedRowsWithTweetId(db, sinceTs);
  if (rows.length === 0) return { fetched: 0, upserted: 0 };

  const byTweetId = new Map(rows.map((r) => [r.tweet_id as string, r]));
  const ids = Array.from(byTweetId.keys());

  let upserted = 0;
  const nowTs = Math.floor(Date.now() / 1000);
  // X caps GET /2/tweets at 100 ids per call — chunk for accounts with a
  // busy enough history that the window holds more than that.
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const metrics = await fetchTweetMetrics(env, batch);
    for (const m of metrics) {
      const row = byTweetId.get(m.tweetId);
      if (!row) continue;
      await db
        .prepare(
          `INSERT INTO x_metrics (tweet_id, queue_id, impressions, likes, replies, reposts, quotes, bookmarks, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(tweet_id) DO UPDATE SET
             queue_id = excluded.queue_id,
             impressions = excluded.impressions,
             likes = excluded.likes,
             replies = excluded.replies,
             reposts = excluded.reposts,
             quotes = excluded.quotes,
             bookmarks = excluded.bookmarks,
             fetched_at = excluded.fetched_at`
        )
        .bind(m.tweetId, row.id, m.impressions, m.likes, m.replies, m.reposts, m.quotes, m.bookmarks, nowTs)
        .run();
      upserted++;
    }
  }

  return { fetched: ids.length, upserted };
}

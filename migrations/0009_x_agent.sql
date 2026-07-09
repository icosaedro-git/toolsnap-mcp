-- Fase 22.1: ToolSnap X Agent — content queue + publisher.
--
-- Lives in the SAME D1 database as prepaid/analytics/oauth (toolsnap-prepaid,
-- binding PREPAID_DB) — no money tables touched, no new database.
--
-- State machine (x_queue.status):
--   draft -> pending_approval -> scheduled -> publishing -> published
--                              \-> rejected            \-> failed (retry, max 3)
--   scheduled -> canceled (vetoed via Telegram/panel)
--   a row whose depends_on parent ends in failed/rejected/canceled -> blocked
--
-- Publisher eligibility (cron */5 * * * *):
--   status='scheduled' AND scheduled_at<=now
--   AND (depends_on IS NULL OR (parent.status='published'
--        AND parent.published_at + min_gap_s <= now))
-- Claimed atomically via UPDATE ... WHERE status='scheduled' (checking
-- `meta.changes`), so an overlapping cron run can never double-publish.

CREATE TABLE IF NOT EXISTS x_queue (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  account             TEXT    NOT NULL,              -- 'product' | 'personal'
  kind                TEXT    NOT NULL DEFAULT 'post', -- post|quote|reply|thread_part|repost
  text                TEXT,                           -- NULL only for a pure repost
  media_keys          TEXT,                           -- JSON array of R2 keys (Fase 22.3; NULL in v1)
  depends_on          INTEGER REFERENCES x_queue(id),  -- parent row for quote/reply/thread chaining
  min_gap_s           INTEGER NOT NULL DEFAULT 3600,   -- min wait after parent publishes
  quote_tweet_id      TEXT,                           -- quoting an EXTERNAL tweet (direct id)
  reply_to_tweet_id   TEXT,                           -- replying to an EXTERNAL tweet
  series              TEXT,                           -- 'tool-spotlight', 'recipe-thread', 'launch'...
  batch_id            TEXT,                           -- weekly planning batch this row came from
  status              TEXT    NOT NULL DEFAULT 'draft',
  scheduled_at         INTEGER,                        -- epoch seconds, required once status='scheduled'
  approval_mode       TEXT    NOT NULL DEFAULT 'per_post', -- per_post|batch|veto|auto — see vault
  veto_notified_at    INTEGER,                        -- veto-window Telegram notice sent at
  tg_message_id       INTEGER,                        -- Telegram approval card message id (for edits)
  tweet_id            TEXT,                           -- resulting tweet id once published
  published_at        INTEGER,                        -- epoch seconds of actual publish (children gate on this)
  error               TEXT,
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at          INTEGER
);
CREATE INDEX IF NOT EXISTS idx_x_queue_due ON x_queue (status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_x_queue_batch ON x_queue (batch_id);
CREATE INDEX IF NOT EXISTS idx_x_queue_depends_on ON x_queue (depends_on);

-- Correction log: every edit/rejection made from Telegram or the panel is
-- recorded here (original vs final text) for editorial quality tracking.
CREATE TABLE IF NOT EXISTS x_corrections (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_id       INTEGER NOT NULL REFERENCES x_queue(id),
  original_text  TEXT    NOT NULL,
  final_text     TEXT    NOT NULL,           -- '' when rejected without an edit
  source         TEXT    NOT NULL,           -- 'telegram_edit'|'telegram_reject'|'session'
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_x_corrections_queue ON x_corrections (queue_id);

-- Engagement metrics (Fase 22.3 fills this; table exists now so 22.1's
-- publisher schema doesn't need a later migration for the tweet_id FK shape).
CREATE TABLE IF NOT EXISTS x_metrics (
  tweet_id      TEXT PRIMARY KEY,
  queue_id      INTEGER REFERENCES x_queue(id),
  impressions   INTEGER,
  likes         INTEGER,
  replies       INTEGER,
  reposts       INTEGER,
  quotes        INTEGER,
  bookmarks     INTEGER,
  fetched_at    INTEGER
);

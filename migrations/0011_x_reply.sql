-- Fase 22.4: reply-guy — discovery, scoring and drafting of X replies.
--
-- Lives in the SAME D1 database as the rest of the X Agent (toolsnap-prepaid,
-- binding PREPAID_DB) — no new database, aditive migration.
--
-- Security note (see vault nota 06 Fase 22, decision 2026-07-09): the actual
-- discovery/scoring/drafting PROMPT and its parameters are strategy, not
-- mechanism — they live as DATA in x_prompts, loaded from the private vault,
-- never hardcoded in this repo. This migration only creates the tables the
-- neutral machinery needs; it inserts no rows.

-- Candidates found by a discovery sweep. One row per post the model
-- considered worth surfacing (whether or not it ended up queued) — kept for
-- auditing, dedupe and the score-vs-outcome learning loop (nota 14 §8).
CREATE TABLE IF NOT EXISTS x_reply_candidates (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  sweep_id          TEXT    NOT NULL,             -- groups all candidates from one discovery run
  tweet_id          TEXT    NOT NULL,
  tweet_url         TEXT,
  author_handle     TEXT,
  author_followers  INTEGER,
  post_age_minutes  INTEGER,
  metrics_json      TEXT,                          -- snapshot at discovery time: {likes, reposts, replies}
  topic             TEXT,
  score             INTEGER,                        -- 0-100, per nota 14 §2
  score_breakdown   TEXT,                           -- JSON: {signal: value, ...} — feeds the learning loop
  draft_reply       TEXT,
  status            TEXT    NOT NULL DEFAULT 'candidate', -- candidate -> alerted -> queued | expired | skipped | duplicate
  queue_id          INTEGER REFERENCES x_queue(id),  -- set once promoted to x_queue (kind='reply')
  cost_usd_estimate REAL,                            -- this candidate's share of the sweep's estimated xAI cost
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_x_reply_candidates_sweep ON x_reply_candidates (sweep_id);
CREATE INDEX IF NOT EXISTS idx_x_reply_candidates_tweet ON x_reply_candidates (tweet_id);
CREATE INDEX IF NOT EXISTS idx_x_reply_candidates_author_day ON x_reply_candidates (author_handle, created_at);

-- Versioned prompts/config loaded from the vault (nota 14) — the "brain".
-- `content` for name='reply_discovery' is the full prompt text sent to xAI;
-- `content` for name='reply_config' is a JSON blob (scoring weights, hard
-- filters, seed accounts, query rotation, sweep schedule, budget/cap) that
-- discovery.ts reads instead of hardcoding any of it. Only one row per name
-- has active=1 at a time.
CREATE TABLE IF NOT EXISTS x_prompts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,             -- 'reply_discovery' | 'reply_config'
  version    INTEGER NOT NULL DEFAULT 1,
  content    TEXT    NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,   -- 0/1 — the loader always reads the active row for a name
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_x_prompts_name_active ON x_prompts (name, active);

-- Reply-guy runtime state — single-row-per-key table (no separate config
-- table needed beyond x_prompts.reply_config): pause/resume, last sweep
-- time, and today's spend/count counters (reset by whichever process reads
-- them first each day, comparing counters.day to the current date).
CREATE TABLE IF NOT EXISTS x_reply_state (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER
);

-- Web Push subscriptions for the panel's desktop notifications (Fase 22.4).
-- One row per browser subscription; endpoint is unique per browser/device.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint   TEXT    NOT NULL UNIQUE,
  p256dh     TEXT    NOT NULL,
  auth       TEXT    NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

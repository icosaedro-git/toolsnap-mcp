/**
 * Reply-guy discovery (Fase 22.4): gate (window/calendar/pause/budget/cap) +
 * one sweep of the xAI x_search loop + deterministic filtering + queueing.
 *
 * Strategy lives as DATA (x_prompts, vault nota 14), not in this file — this
 * module is neutral machinery: it reads whatever prompt/config is active in
 * D1 and does nothing if none is loaded (no hardcoded fallback prompt).
 */
import { runDiscoverySweep, type XaiEnv } from "./xai.js";
import { sendReplyApprovalCard } from "./telegram-approval.js";
import type { XTelegramEnv } from "./telegram.js";
import { now } from "./queue.js";

export interface XDiscoveryEnv extends XaiEnv, XTelegramEnv {
  PREPAID_DB: D1Database;
}

export interface ReplyConfig {
  window: { startHour: number; endHour: number }; // Europe/Madrid, e.g. 16-23
  sweepsPerDay: Record<string, number>; // 'mon'..'sun' -> sweep count
  dailyBudgetUsd: number;
  dailyCap: number;
  minScore: number;
  ttlS: number; // how long an unactioned candidate stays valid before expiring
  maxCandidatesPerSweep: number;
  maxSearchesPerSweep: number;
  // Substituted into the {seed_accounts}/{query_rotation} placeholders in the
  // reply_discovery prompt (nota 14 §3/§4) — data, not strategy embedded in
  // code: this list is Fable's initial proposal pending Unai's curation from
  // his own follows, and is meant to be updated via POST /x-api/prompts
  // (name='reply_config') without a code change.
  seedAccounts: string[];
  queryRotation: string[];
}

const DEFAULT_CONFIG: ReplyConfig = {
  window: { startHour: 16, endHour: 23 },
  sweepsPerDay: { mon: 4, tue: 4, wed: 4, thu: 4, fri: 2, sat: 0, sun: 2 },
  dailyBudgetUsd: 0.7,
  dailyCap: 5, // P1 calibration default (nota 14 §6)
  minScore: 70,
  ttlS: 45 * 60,
  maxCandidatesPerSweep: 3,
  maxSearchesPerSweep: 4,
  seedAccounts: [],
  queryRotation: [
    "AI/labs news gaining momentum right now",
    "agent/MCP/Claude Code/Cursor conversation — questions, hot takes, context or cost complaints",
    "indie hacker build-in-public milestones (revenue, launches, honest fails)",
    "crypto x AI: agent payments, stablecoins, x402, Base",
  ],
};

/** Fill {max_searches}/{max_candidates}/{min_score}/{seed_accounts}/{query_rotation} in the vault-sourced prompt (nota 14 §4) with the active config's actual values. Never send a placeholder to xAI verbatim. Exported for a direct unit check in scripts/x-agent-test.mts (X_DRY_RUN can't observe what xai.ts actually received over HTTP). */
export function fillPromptPlaceholders(promptText: string, config: ReplyConfig): string {
  return promptText
    .replace(/\{max_searches\}/g, String(config.maxSearchesPerSweep))
    .replace(/\{max_candidates\}/g, String(config.maxCandidatesPerSweep))
    .replace(/\{min_score\}/g, String(config.minScore))
    .replace(/\{seed_accounts\}/g, config.seedAccounts.length ? config.seedAccounts.join(", ") : "(none configured yet)")
    .replace(/\{query_rotation\}/g, config.queryRotation.map((q) => `- ${q}`).join("\n"));
}

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function madridNow(): { hour: number; dayKey: (typeof DAY_KEYS)[number]; dateStr: string } {
  const d = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Madrid",
    hour: "numeric",
    hourCycle: "h23",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(d);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const weekday = (parts.find((p) => p.type === "weekday")?.value ?? "").toLowerCase().slice(0, 3);
  const dayKey = (DAY_KEYS.find((k) => k === weekday) ?? "mon") as (typeof DAY_KEYS)[number];
  const dateStr = `${parts.find((p) => p.type === "year")?.value}-${parts.find((p) => p.type === "month")?.value}-${parts.find((p) => p.type === "day")?.value}`;
  return { hour, dayKey, dateStr };
}

async function getPrompt(db: D1Database, name: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT content FROM x_prompts WHERE name = ? AND active = 1 ORDER BY version DESC LIMIT 1")
    .bind(name)
    .first<{ content: string }>();
  return row?.content ?? null;
}

async function getConfig(db: D1Database): Promise<ReplyConfig> {
  const raw = await getPrompt(db, "reply_config");
  if (!raw) return DEFAULT_CONFIG;
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

async function getState(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM x_reply_state WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

async function setState(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO x_reply_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    )
    .bind(key, value, now())
    .run();
}

interface DayCounters {
  date: string;
  spendUsd: number;
  repliesQueued: number;
  sweepsRun: number;
}

async function getTodayCounters(db: D1Database, dateStr: string): Promise<DayCounters> {
  const raw = await getState(db, "day_counters");
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as DayCounters;
      if (parsed.date === dateStr) return parsed;
    } catch {
      // fall through to fresh counters
    }
  }
  return { date: dateStr, spendUsd: 0, repliesQueued: 0, sweepsRun: 0 };
}

async function saveCounters(db: D1Database, counters: DayCounters): Promise<void> {
  await setState(db, "day_counters", JSON.stringify(counters));
}

export interface DiscoveryGateResult {
  shouldRun: boolean;
  reason: string;
}

/** Pause the discovery sweep for `untilTs` (epoch seconds). Approving/rejecting the queue itself is unaffected. */
export async function pauseDiscovery(db: D1Database, untilTs: number): Promise<void> {
  await setState(db, "paused_until", String(untilTs));
}

export async function resumeDiscovery(db: D1Database): Promise<void> {
  await setState(db, "paused_until", "0");
}

export async function getDiscoveryStatus(db: D1Database): Promise<{
  pausedUntil: number;
  counters: DayCounters;
  config: ReplyConfig;
}> {
  const pausedUntil = Number((await getState(db, "paused_until")) ?? "0");
  const { dateStr } = madridNow();
  const counters = await getTodayCounters(db, dateStr);
  const config = await getConfig(db);
  return { pausedUntil, counters, config };
}

/** True if a sweep should run right now — checked on every publisher tick (every 5 min), cheap D1 reads only. */
export async function shouldRunSweep(db: D1Database): Promise<DiscoveryGateResult> {
  const config = await getConfig(db);
  const { hour, dayKey, dateStr } = madridNow();

  const pausedUntil = Number((await getState(db, "paused_until")) ?? "0");
  if (pausedUntil > now()) return { shouldRun: false, reason: "paused" };

  if (hour < config.window.startHour || hour >= config.window.endHour) {
    return { shouldRun: false, reason: "outside active window" };
  }

  const targetSweeps = config.sweepsPerDay[dayKey] ?? 0;
  if (targetSweeps <= 0) return { shouldRun: false, reason: `no sweeps scheduled for ${dayKey}` };

  const counters = await getTodayCounters(db, dateStr);
  if (counters.sweepsRun >= targetSweeps) return { shouldRun: false, reason: "today's sweep quota reached" };

  if (counters.spendUsd >= config.dailyBudgetUsd) return { shouldRun: false, reason: "daily budget reached" };
  if (counters.repliesQueued >= config.dailyCap) return { shouldRun: false, reason: "daily reply cap reached" };

  const lastSweepAt = Number((await getState(db, "last_sweep_at")) ?? "0");
  const windowSeconds = (config.window.endHour - config.window.startHour) * 3600;
  const minGapS = Math.floor(windowSeconds / Math.max(targetSweeps, 1));
  if (now() - lastSweepAt < minGapS) return { shouldRun: false, reason: "too soon since last sweep" };

  return { shouldRun: true, reason: "ok" };
}

interface RawCandidate {
  tweet_id?: string;
  tweet_url?: string;
  author_handle?: string;
  author_followers?: number;
  post_age_minutes?: number;
  metrics?: { likes?: number; reposts?: number; replies?: number };
  topic?: string;
  score?: number;
  score_reasons?: string[];
  draft_reply?: string;
}

function passesHardFilters(c: RawCandidate, config: ReplyConfig): boolean {
  if (!c.tweet_id || !c.draft_reply?.trim()) return false;
  if (typeof c.post_age_minutes === "number" && c.post_age_minutes > 6 * 60) return false;
  if (typeof c.metrics?.replies === "number" && c.metrics.replies > 200) return false;
  const followers = c.author_followers ?? 0;
  const earlyException = (c.post_age_minutes ?? 999) < 60 && (c.metrics?.replies ?? 0) < 100;
  if (followers > 2_000_000 && !earlyException) return false;
  if (followers < 2_000 && followers > 0) return false;
  if (typeof c.score === "number" && c.score < config.minScore) return false;
  return true;
}

/**
 * Run one discovery sweep: load the active prompt+config, call xAI, filter
 * deterministically, dedupe against recent candidates, insert the top N as
 * `x_reply_candidates` + `x_queue` (kind='reply', per_post approval) rows,
 * and send a Telegram alert card for each. No-ops cleanly (with a reason) if
 * no prompt is loaded — this repo carries no fallback strategy.
 *
 * `opts.bypassSchedule` skips the window/calendar/min-gap-since-last-sweep
 * checks (but NOT pause/budget/cap, which stay enforced as real safety
 * limits) — used by the `POST /x-api/replies/sweep` diagnostic endpoint so a
 * sweep can be tested on demand instead of waiting for the next scheduled
 * window (e.g. verifying the xAI integration the first time, or a day the
 * calendar has zero sweeps configured).
 */
export async function runReplyDiscoverySweep(
  env: XDiscoveryEnv,
  opts: { bypassSchedule?: boolean } = {}
): Promise<{ ran: boolean; reason: string; queued: number }> {
  const db = env.PREPAID_DB;
  const gate = await shouldRunSweep(db);
  if (!gate.shouldRun && !(opts.bypassSchedule && gate.reason !== "paused" && gate.reason !== "daily budget reached" && gate.reason !== "daily reply cap reached")) {
    return { ran: false, reason: gate.reason, queued: 0 };
  }

  const rawPromptText = await getPrompt(db, "reply_discovery");
  if (!rawPromptText) return { ran: false, reason: "no reply_discovery prompt loaded in x_prompts", queued: 0 };

  const config = await getConfig(db);
  const promptText = fillPromptPlaceholders(rawPromptText, config);
  const { dateStr } = madridNow();
  const sweepId = `sweep-${Date.now()}`;

  const sweep = await runDiscoverySweep(env, promptText);
  await setState(db, "last_sweep_at", String(now()));

  let counters = await getTodayCounters(db, dateStr);
  counters = { ...counters, sweepsRun: counters.sweepsRun + 1, spendUsd: counters.spendUsd + sweep.costUsdEstimate };

  let raw: RawCandidate[];
  try {
    raw = JSON.parse(sweep.rawText);
    if (!Array.isArray(raw)) throw new Error("not an array");
  } catch {
    await saveCounters(db, counters);
    return { ran: true, reason: "model response was not a valid JSON array — see raw text in logs", queued: 0 };
  }

  const remainingCap = config.dailyCap - counters.repliesQueued;
  const candidates = raw
    .filter((c) => passesHardFilters(c, config))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, Math.min(config.maxCandidatesPerSweep, Math.max(remainingCap, 0)));

  let queued = 0;
  for (const c of candidates) {
    // Dedupe: same tweet already surfaced, or same author already queued today.
    const dup = await db
      .prepare(
        "SELECT id FROM x_reply_candidates WHERE tweet_id = ? OR (author_handle = ? AND created_at >= ?) LIMIT 1"
      )
      .bind(c.tweet_id, c.author_handle ?? "", now() - 86400)
      .first<{ id: number }>();
    if (dup) continue;

    const candidateRes = await db
      .prepare(
        `INSERT INTO x_reply_candidates
           (sweep_id, tweet_id, tweet_url, author_handle, author_followers, post_age_minutes,
            metrics_json, topic, score, score_breakdown, draft_reply, status, cost_usd_estimate, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'alerted', ?, ?)`
      )
      .bind(
        sweepId,
        c.tweet_id,
        c.tweet_url ?? null,
        c.author_handle ?? null,
        c.author_followers ?? null,
        c.post_age_minutes ?? null,
        JSON.stringify(c.metrics ?? {}),
        c.topic ?? null,
        c.score ?? null,
        JSON.stringify(c.score_reasons ?? []),
        c.draft_reply,
        sweep.costUsdEstimate / Math.max(candidates.length, 1),
        now()
      )
      .run();
    const candidateId = candidateRes.meta.last_row_id as number;

    const queueRes = await db
      .prepare(
        `INSERT INTO x_queue
           (account, kind, text, reply_to_tweet_id, series, status, scheduled_at, approval_mode, created_at)
         VALUES ('personal', 'reply', ?, ?, 'reply-guy', 'pending_approval', ?, 'per_post', ?)`
      )
      .bind(c.draft_reply, c.tweet_id, now(), now())
      .run();
    const queueId = queueRes.meta.last_row_id as number;
    await db.prepare("UPDATE x_reply_candidates SET queue_id = ? WHERE id = ?").bind(queueId, candidateId).run();

    await sendReplyApprovalCard(env, db, {
      queueId,
      candidateId,
      tweetUrl: c.tweet_url ?? `https://x.com/i/web/status/${c.tweet_id}`,
      authorHandle: c.author_handle ?? "unknown",
      authorFollowers: c.author_followers ?? 0,
      score: c.score ?? 0,
      draftReply: c.draft_reply ?? "",
    });

    counters = { ...counters, repliesQueued: counters.repliesQueued + 1 };
    queued++;
  }

  await saveCounters(db, counters);
  return { ran: true, reason: "ok", queued };
}

/**
 * Expire reply candidates whose parent post has aged past TTL without a
 * decision — silence means "do not publish" for replies (the inverse of the
 * veto ladder). Cancels the x_queue row (blocking any future action on it,
 * same as a manual cancel) and marks the candidate `expired`.
 */
export async function expireStaleReplyCandidates(db: D1Database): Promise<number> {
  const config = await getConfig(db);
  const cutoff = now() - config.ttlS;
  const stale = await db
    .prepare(
      `SELECT c.id AS candidate_id, c.queue_id FROM x_reply_candidates c
       JOIN x_queue q ON q.id = c.queue_id
       WHERE c.status = 'alerted' AND q.status = 'pending_approval' AND c.created_at < ?`
    )
    .bind(cutoff)
    .all<{ candidate_id: number; queue_id: number }>();

  for (const row of stale.results ?? []) {
    await db
      .prepare("UPDATE x_queue SET status = 'canceled', error = 'expired', updated_at = ? WHERE id = ? AND status = 'pending_approval'")
      .bind(now(), row.queue_id)
      .run();
    await db.prepare("UPDATE x_reply_candidates SET status = 'expired', updated_at = ? WHERE id = ?").bind(now(), row.candidate_id).run();
  }
  return stale.results?.length ?? 0;
}

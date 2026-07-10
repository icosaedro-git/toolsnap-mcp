/**
 * Fase 22.3 — the panel/action endpoints beyond the original load/list/cancel
 * trio in admin.ts (kept there since both the headless `/x-api/*` mount and
 * the browser-facing `/x-agent/api/*` mount share every one of these
 * handlers — see the routing note in src/index.ts and README.md for why the
 * two mounts exist and how auth differs between them).
 */

import {
  approveRow,
  editRowText,
  getQueueRow,
  insertCorrection,
  markPublishedManual,
  publishNowRow,
  rejectRow,
  rescheduleRow,
} from "./queue.js";
import { handleLoadBatch, handleListQueue, handleCancelRow, type BatchInput, type XAdminEnv } from "./admin.js";

export interface PanelApiEnv {
  PREPAID_DB: D1Database;
  SCREENSHOTS_BUCKET: R2Bucket;
}

export interface XAgentApiEnv extends XAdminEnv, PanelApiEnv {}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "Content-Type": "application/json" } });
}

function jsonError(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

export async function handleApproveRow(env: PanelApiEnv, id: number): Promise<Response> {
  return jsonResponse({ approved: await approveRow(env.PREPAID_DB, id) });
}

export async function handleRejectRow(env: PanelApiEnv, id: number): Promise<Response> {
  return jsonResponse({ rejected: await rejectRow(env.PREPAID_DB, id) });
}

export async function handleEditRow(env: PanelApiEnv, id: number, body: { text?: string }): Promise<Response> {
  const text = body.text?.trim();
  if (!text) return jsonError("text is required");
  return jsonResponse({ edited: await editRowText(env.PREPAID_DB, id, text, "panel_edit") });
}

export async function handleRescheduleRow(env: PanelApiEnv, id: number, body: { scheduled_at?: number }): Promise<Response> {
  if (!Number.isFinite(body.scheduled_at) || (body.scheduled_at as number) <= 0) {
    return jsonError("scheduled_at must be a positive epoch-seconds number");
  }
  return jsonResponse({ rescheduled: await rescheduleRow(env.PREPAID_DB, id, body.scheduled_at as number) });
}

export async function handlePublishNowRow(env: PanelApiEnv, id: number): Promise<Response> {
  return jsonResponse({ scheduled_now: await publishNowRow(env.PREPAID_DB, id) });
}

// Accepts a full tweet URL (x.com or twitter.com, /status/ or /statuses/) or
// a bare numeric id. Returns null (not an error) for an empty/missing value
// — "mark published with no link" is a deliberate, valid choice (D6).
function parseTweetId(input: string | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const match = trimmed.match(/status(?:es)?\/(\d+)/);
  return match ? match[1] : null;
}

export async function handleMarkPublishedRow(env: PanelApiEnv, id: number, body: { tweet_url?: string }): Promise<Response> {
  if (body.tweet_url && !parseTweetId(body.tweet_url)) {
    return jsonError('tweet_url is set but no tweet id could be parsed from it — expected a x.com/twitter.com status link or a bare numeric id');
  }
  const tweetId = parseTweetId(body.tweet_url);
  const ok = await markPublishedManual(env.PREPAID_DB, id, tweetId);
  return jsonResponse({ marked_published: ok, tweet_id: tweetId, metrics_enabled: Boolean(tweetId) });
}

const ALLOWED_MEDIA: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};
const MAX_MEDIA_BYTES = 5 * 1024 * 1024;

/** POST .../media — raw image bytes in the body, Content-Type set to the image mime type. Mirrors the existing POST /upload pattern but under x-media/ (Fase 22.3 queue attachments, not the general-purpose uploads/ used by tools). */
export async function handleMediaUpload(env: PanelApiEnv, request: Request): Promise<Response> {
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const ext = ALLOWED_MEDIA[contentType];
  if (!ext) {
    return jsonError(
      `Unsupported content-type "${contentType}". Allowed: image/jpeg, image/png, image/webp, image/gif`,
      415
    );
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_MEDIA_BYTES) {
    return jsonError("File too large (max 5 MB per image)", 413);
  }
  const key = `x-media/${Date.now()}-${Math.random().toString(36).slice(2, 9)}.${ext}`;
  await env.SCREENSHOTS_BUCKET.put(key, bytes, { httpMetadata: { contentType } });
  return jsonResponse({ media_key: key, content_type: contentType, file_size_bytes: bytes.byteLength });
}

/**
 * POST .../corrections — backfill a correction made outside the running
 * system (the vault's weekly review notes, per nota 13 §3/§6) so the
 * correction-rate criterion in handleStats reads from one D1 query instead
 * of cross-referencing the vault by hand. `source` is always forced to
 * 'vault_review' here — this endpoint has exactly one purpose, unlike
 * telegram_edit/panel_edit which are inserted by their own code paths.
 */
export async function handleAddCorrection(
  env: PanelApiEnv,
  body: { queue_id?: number; original_text?: string; final_text?: string }
): Promise<Response> {
  const queueId = body.queue_id;
  if (!Number.isFinite(queueId)) return jsonError("queue_id is required");
  const row = await getQueueRow(env.PREPAID_DB, queueId as number);
  if (!row) return jsonError(`queue row #${queueId} not found`, 404);
  const originalText = body.original_text ?? row.text ?? "";
  const finalText = body.final_text ?? "";
  await insertCorrection(env.PREPAID_DB, queueId as number, originalText, finalText, "vault_review");
  return jsonResponse({ inserted: true });
}

interface CorrectionRateRow {
  series: string;
  account: string;
  total: number;
  corrected: number;
}

interface EngagementRow {
  series: string;
  account: string;
  n: number;
  avg_impressions: number | null;
  avg_likes: number | null;
  avg_replies: number | null;
  avg_reposts: number | null;
  avg_quotes: number | null;
  avg_bookmarks: number | null;
}

/**
 * GET .../stats — correction rate per series+account (numerator: distinct
 * corrected rows; denominator: every row of that series/account that ever
 * reached a decision point, i.e. not draft/blocked) and average engagement
 * per series+account from x_metrics. Feeds the L1->L2 ladder-promotion
 * criterion in vault nota 13 §4 (>=2 consecutive weeks <20% correction rate)
 * and the "which series works" question x_metrics exists to answer.
 */
export async function handleStats(env: PanelApiEnv): Promise<Response> {
  const db = env.PREPAID_DB;

  const correctionRates = await db
    .prepare(
      `SELECT q.series AS series, q.account AS account,
              COUNT(DISTINCT q.id) AS total,
              COUNT(DISTINCT c.queue_id) AS corrected
       FROM x_queue q
       LEFT JOIN x_corrections c ON c.queue_id = q.id
       WHERE q.series IS NOT NULL AND q.status NOT IN ('draft', 'blocked')
       GROUP BY q.series, q.account
       ORDER BY q.series, q.account`
    )
    .all<CorrectionRateRow>();

  const engagement = await db
    .prepare(
      `SELECT q.series AS series, q.account AS account,
              COUNT(m.tweet_id) AS n,
              AVG(m.impressions) AS avg_impressions,
              AVG(m.likes) AS avg_likes,
              AVG(m.replies) AS avg_replies,
              AVG(m.reposts) AS avg_reposts,
              AVG(m.quotes) AS avg_quotes,
              AVG(m.bookmarks) AS avg_bookmarks
       FROM x_metrics m
       JOIN x_queue q ON q.id = m.queue_id
       WHERE q.series IS NOT NULL
       GROUP BY q.series, q.account
       ORDER BY q.series, q.account`
    )
    .all<EngagementRow>();

  return jsonResponse({
    correction_rates: (correctionRates.results ?? []).map((r) => ({
      ...r,
      rate: r.total > 0 ? Math.round((r.corrected / r.total) * 100) : 0,
    })),
    engagement: engagement.results ?? [],
  });
}

const QUEUE_ID_ACTION = /^queue\/(\d+)\/(approve|reject|cancel|edit|reschedule|publish-now|mark-published)$/;

/**
 * Single dispatcher shared by both mounts (see routing note in
 * src/index.ts): headless `/x-api/*` (x-admin-key) and browser-facing
 * `/x-agent/api/*` (Cloudflare Access) call the exact same handlers, so
 * behavior can never drift between the two. `subpath` is the path with the
 * mount prefix already stripped (e.g. "queue", "queue/5/approve", "media").
 * Returns null for no match — the caller turns that into its own 404.
 */
export async function dispatchXAgentApi(
  env: XAgentApiEnv,
  request: Request,
  url: URL,
  subpath: string
): Promise<Response | null> {
  const method = request.method;

  if (subpath === "queue") {
    if (method === "POST") {
      let payload: BatchInput;
      try {
        payload = await request.json();
      } catch {
        return jsonError("Invalid JSON body");
      }
      return handleLoadBatch(env, payload);
    }
    if (method === "GET") return handleListQueue(env, url);
    return null;
  }

  if (method === "POST") {
    const idMatch = subpath.match(QUEUE_ID_ACTION);
    if (idMatch) {
      const id = Number(idMatch[1]);
      const action = idMatch[2];
      if (action === "approve") return handleApproveRow(env, id);
      if (action === "reject") return handleRejectRow(env, id);
      if (action === "cancel") return handleCancelRow(env, id);
      if (action === "publish-now") return handlePublishNowRow(env, id);
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      if (action === "edit") return handleEditRow(env, id, body as { text?: string });
      if (action === "reschedule") return handleRescheduleRow(env, id, body as { scheduled_at?: number });
      if (action === "mark-published") return handleMarkPublishedRow(env, id, body as { tweet_url?: string });
    }
    if (subpath === "media") return handleMediaUpload(env, request);
    if (subpath === "corrections") {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      return handleAddCorrection(env, body as { queue_id?: number; original_text?: string; final_text?: string });
    }
  }

  if (method === "GET" && subpath === "stats") return handleStats(env);

  return null;
}

/**
 * Admin endpoints for loading/managing the X Agent content queue
 * (Fase 22.1, veto mode added in Fase 22.2). Gated by the same x-admin-key
 * pattern as /admin/keys/* and the /mcp admin bypass (src/index.ts).
 *
 * POST /x-api/queue          — load a batch (weekly planning session, or a
 *                                 single ad-hoc post) as JSON.
 * GET  /x-api/queue          — inspect current queue state.
 * POST /x-api/queue/:id/cancel — veto/cancel a scheduled or pending row.
 *
 * See README.md in this directory for the full batch JSON contract.
 */

import { cancelRow, now, type XApprovalMode, type XQueueRow, type XQueueStatus } from "./queue.js";
import { sendApprovalCard } from "./telegram-approval.js";
import type { XTelegramEnv } from "./telegram.js";

export interface XAdminEnv extends XTelegramEnv {
  PREPAID_DB: D1Database;
}

type BatchItemKind = "post" | "quote" | "reply" | "thread_part" | "repost";

interface BatchItemInput {
  local_id?: string;
  account: "product" | "personal";
  kind?: BatchItemKind;
  text?: string;
  depends_on?: string; // either another item's local_id in this batch, or an existing numeric queue id (as a string)
  min_gap_s?: number;
  quote_tweet_id?: string;
  reply_to_tweet_id?: string;
  series?: string;
  scheduled_at: number; // epoch seconds
  approval_mode?: XApprovalMode; // per-item override of the batch default
}

export interface BatchInput {
  batch_id?: string;
  approval_mode?: XApprovalMode; // default for items that don't override
  items: BatchItemInput[];
}

function validateItem(item: BatchItemInput, index: number): string | null {
  if (item.account !== "product" && item.account !== "personal") {
    return `items[${index}]: account must be "product" or "personal"`;
  }
  const kind = item.kind ?? "post";
  if (!["post", "quote", "reply", "thread_part", "repost"].includes(kind)) {
    return `items[${index}]: invalid kind "${kind}"`;
  }
  if (kind !== "repost" && !item.text?.trim()) {
    return `items[${index}]: text is required for kind "${kind}"`;
  }
  if (!Number.isFinite(item.scheduled_at) || item.scheduled_at <= 0) {
    return `items[${index}]: scheduled_at must be a positive epoch-seconds number`;
  }
  return null;
}

/**
 * POST /x-api/queue — load a batch. Two-pass insert so `depends_on` can
 * reference a sibling item's `local_id` (resolved to its DB id after both
 * rows exist) as well as an already-existing numeric queue id.
 */
export async function handleLoadBatch(env: XAdminEnv, body: BatchInput): Promise<Response> {
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return jsonError("items must be a non-empty array");
  }
  if (body.items.length > 100) {
    return jsonError("items exceeds the 100-per-batch limit");
  }

  for (let i = 0; i < body.items.length; i++) {
    const err = validateItem(body.items[i], i);
    if (err) return jsonError(err);
  }

  // depends_on referencing a local_id must point at a local_id that exists
  // in this batch (numeric-looking depends_on is treated as an existing DB id).
  const localIds = new Set(body.items.map((it) => it.local_id).filter(Boolean));
  for (let i = 0; i < body.items.length; i++) {
    const dep = body.items[i].depends_on;
    if (dep && !/^\d+$/.test(dep) && !localIds.has(dep)) {
      return jsonError(`items[${i}]: depends_on "${dep}" is not a local_id in this batch nor a numeric queue id`);
    }
  }

  const db = env.PREPAID_DB;
  const batchId = body.batch_id ?? `batch-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
  const defaultMode: XApprovalMode = body.approval_mode ?? "per_post";
  const ts = now();

  const localIdToDbId = new Map<string, number>();
  const inserted: { local_id?: string; id: number; status: XQueueStatus }[] = [];

  for (const item of body.items) {
    const mode = item.approval_mode ?? defaultMode;
    if (mode !== "per_post" && mode !== "batch" && mode !== "veto") {
      return jsonError(`items: approval_mode "${mode}" not supported at creation time (only per_post/batch/veto — auto is a ladder promotion applied later, never set at creation)`);
    }
    // veto rows go straight to 'scheduled' like batch — they publish on their
    // own, but the publisher cron gates them on a Telegram cancel-window
    // notice being sent first (see getVetoRowsNeedingNotice/getDueRows in
    // queue.ts), instead of the batch/per_post approval flow.
    const status: XQueueStatus = mode === "batch" || mode === "veto" ? "scheduled" : "pending_approval";
    const kind = item.kind ?? "post";

    const res = await db
      .prepare(
        `INSERT INTO x_queue
           (account, kind, text, min_gap_s, quote_tweet_id, reply_to_tweet_id, series, batch_id,
            status, scheduled_at, approval_mode, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        item.account,
        kind,
        item.text?.trim() ?? null,
        item.min_gap_s ?? 3600,
        item.quote_tweet_id ?? null,
        item.reply_to_tweet_id ?? null,
        item.series ?? null,
        batchId,
        status,
        item.scheduled_at,
        mode,
        ts
      )
      .run();
    const id = res.meta.last_row_id as number;
    if (item.local_id) localIdToDbId.set(item.local_id, id);
    inserted.push({ local_id: item.local_id, id, status });
  }

  // Second pass: resolve depends_on now that every row in the batch has a DB id.
  for (let i = 0; i < body.items.length; i++) {
    const dep = body.items[i].depends_on;
    if (!dep) continue;
    const parentId = /^\d+$/.test(dep) ? Number(dep) : localIdToDbId.get(dep);
    if (!parentId) continue; // validated above; defensive no-op
    await db.prepare("UPDATE x_queue SET depends_on = ? WHERE id = ?").bind(parentId, inserted[i].id).run();
  }

  // Fire Telegram approval cards for per_post rows (L0). Batch-mode rows are
  // already `scheduled` — no card, they were pre-approved in the planning session.
  for (const row of inserted) {
    if (row.status === "pending_approval") {
      const fullRow = await db.prepare("SELECT * FROM x_queue WHERE id = ?").bind(row.id).first<XQueueRow>();
      if (fullRow) await sendApprovalCard(env, db, fullRow);
    }
  }

  return jsonResponse({ batch_id: batchId, inserted });
}

export async function handleListQueue(env: XAdminEnv, url: URL): Promise<Response> {
  const status = url.searchParams.get("status");
  const account = url.searchParams.get("account");
  const batchId = url.searchParams.get("batch_id");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (status) {
    conditions.push("status = ?");
    params.push(status);
  }
  if (account) {
    conditions.push("account = ?");
    params.push(account);
  }
  if (batchId) {
    conditions.push("batch_id = ?");
    params.push(batchId);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);

  const res = await env.PREPAID_DB
    .prepare(`SELECT * FROM x_queue ${where} ORDER BY scheduled_at ASC LIMIT ?`)
    .bind(...params)
    .all();
  return jsonResponse({ rows: res.results ?? [] });
}

export async function handleCancelRow(env: XAdminEnv, id: number): Promise<Response> {
  const ok = await cancelRow(env.PREPAID_DB, id);
  return jsonResponse({ canceled: ok });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "Content-Type": "application/json" } });
}

function jsonError(message: string): Response {
  return jsonResponse({ error: message }, 400);
}

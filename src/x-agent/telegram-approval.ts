/**
 * Telegram approval flow (autonomy level L0 — per-post approval) for the X
 * Agent's dedicated bot. Card has 3 buttons: Approve / Reject / Edit.
 * "Edit" doesn't open a separate state machine — the operator just replies
 * to the approval card with the corrected text; we detect that via
 * message.reply_to_message.message_id matching a pending row's
 * tg_message_id, which needs no server-side session state.
 *
 * Fase 22.4 adds reply-guy: a 4th button ("📋 publicada a mano") on reply
 * cards, immediate publish-on-approve for `kind='reply'` rows (timing
 * matters for replies — no waiting for the next cron tick), and /pause,
 * /resume, /status text commands. This module has an intentional circular
 * import with discovery.ts (it calls pauseDiscovery/resumeDiscovery/
 * getDiscoveryStatus; discovery.ts calls sendReplyApprovalCard here) — safe
 * because neither side touches the other's exports at module-init time,
 * only inside function bodies, which ES modules resolve correctly via live
 * bindings.
 */

import {
  sendXAgentMessage,
  editXAgentMessageText,
  answerCallbackQuery,
  sendXAgentReply,
  type XTelegramEnv,
} from "./telegram.js";
import { approveRow, cancelRow, editAndApproveRow, getQueueRow, markPublishedManual, rejectRow, type XQueueRow } from "./queue.js";
import { attemptPublishNow, type PublishOneEnv } from "./publish-one.js";
import { pauseDiscovery, resumeDiscovery, getDiscoveryStatus } from "./discovery.js";

export interface TelegramApprovalEnv extends XTelegramEnv, PublishOneEnv {}

/** Human-readable card text for a queue row — shared by the L0 approval card and the L2 veto notice. */
export function formatCard(row: XQueueRow): string {
  const accountLabel = row.account === "product" ? "@ToolSnapMCP" : "@icosaedro_one";
  const when = row.scheduled_at ? new Date(row.scheduled_at * 1000).toISOString() : "sin hora";
  const kindLabel =
    row.kind === "quote"
      ? "quote-post"
      : row.kind === "reply"
      ? "reply"
      : row.kind === "thread_part"
      ? "hilo"
      : row.kind === "repost"
      ? "repost"
      : "post";
  const lines = [
    `📝 *${accountLabel}* — ${kindLabel}${row.series ? ` (${row.series})` : ""}`,
    ``,
    row.text ?? "_(sin texto — repost puro)_",
    ``,
    `🕐 Programado: ${when}`,
  ];
  if (row.depends_on) lines.push(`↳ depende de #${row.depends_on}`);
  if (row.kind === "reply" && row.reply_to_tweet_id) {
    lines.push(`🔗 https://x.com/i/web/status/${row.reply_to_tweet_id}`);
  }
  return lines.join("\n");
}

export interface ReplyCandidateInfo {
  queueId: number;
  candidateId: number;
  tweetUrl: string;
  authorHandle: string;
  authorFollowers: number;
  score: number;
  draftReply: string;
}

/** Fase 22.4 — the richer initial alert for a reply candidate (author/score/link the follow-up formatCard doesn't have). */
function formatReplyCard(info: ReplyCandidateInfo): string {
  return [
    `💬 *reply candidate* — @${info.authorHandle} (${info.authorFollowers.toLocaleString()} followers) · score ${info.score}`,
    ``,
    `🔗 ${info.tweetUrl}`,
    ``,
    `Draft:`,
    info.draftReply,
  ].join("\n");
}

/**
 * Send the alert card for a discovered reply candidate (Fase 22.4). 4
 * buttons: Approve (publishes immediately via the X API), 📋 published
 * manually (Unai pasted it himself in X — zero API cost, the preferred
 * path since he's already there for the manual like/follow), Edit, Reject.
 */
export async function sendReplyApprovalCard(env: XTelegramEnv, db: D1Database, info: ReplyCandidateInfo): Promise<void> {
  const messageId = await sendXAgentMessage(env, formatReplyCard(info), {
    inlineKeyboard: [
      [
        { text: "✅ Publicar (API)", callback_data: `xq:${info.queueId}:approve` },
        { text: "📋 Publicada a mano", callback_data: `xq:${info.queueId}:manual` },
      ],
      [
        { text: "✏️ Editar", callback_data: `xq:${info.queueId}:edit` },
        { text: "❌ Rechazar", callback_data: `xq:${info.queueId}:reject` },
      ],
    ],
  });
  if (messageId) {
    await db.prepare("UPDATE x_queue SET tg_message_id = ? WHERE id = ?").bind(messageId, info.queueId).run();
  }
}

/** Send an approval card for a pending_approval row and persist its Telegram message id. */
export async function sendApprovalCard(
  env: XTelegramEnv,
  db: D1Database,
  row: XQueueRow
): Promise<void> {
  const messageId = await sendXAgentMessage(env, formatCard(row), {
    inlineKeyboard: [
      [
        { text: "✅ Aprobar", callback_data: `xq:${row.id}:approve` },
        { text: "❌ Rechazar", callback_data: `xq:${row.id}:reject` },
        { text: "✏️ Editar", callback_data: `xq:${row.id}:edit` },
      ],
    ],
  });
  if (messageId) {
    await db
      .prepare("UPDATE x_queue SET tg_message_id = ? WHERE id = ?")
      .bind(messageId, row.id)
      .run();
  }
}

export interface TelegramUpdate {
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number };
    reply_to_message?: { message_id: number };
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: { message_id: number; chat: { id: number } };
  };
}

interface ReplyPublishOutcome {
  text: string;
  /** Set when the API attempt did NOT end in a real publish — the failure notice needs a way forward, not a dead end (found 2026-07-11: a real X 403 — "not allowed to reply unless mentioned/engaged by the author" — left the row `failed` with no button on the card to recover it). */
  offerManualButton: boolean;
}

/**
 * After approving/editing a `kind='reply'` row, publish it right away
 * instead of waiting for the next cron tick — timing is the whole point of
 * a reply (nota 14 §1/§5). Marks the associated candidate 'queued' either
 * way. On any outcome other than a real publish, the card keeps a
 * "📋 Publicada a mano" button (see markPublishedManual's Fase 22.4
 * extension to also accept `failed` rows) — X can legitimately reject a
 * reply (conversation restricted to mentioned/engaged accounts) and that's
 * not a bug to retry, it's Unai doing it by hand instead.
 */
async function publishReplyNowAndMarkCandidate(env: TelegramApprovalEnv, db: D1Database, id: number): Promise<ReplyPublishOutcome> {
  const row = await getQueueRow(db, id);
  await db.prepare("UPDATE x_reply_candidates SET status = 'queued', updated_at = ? WHERE queue_id = ?").bind(Math.floor(Date.now() / 1000), id).run();
  if (!row) return { text: "❌ *Error: fila no encontrada*", offerManualButton: false };
  const result = await attemptPublishNow(env, row);
  if (result.status === "published") {
    return { text: `${formatCard({ ...row, status: "published", tweet_id: result.tweetId })}\n\n✅ *Publicado*`, offerManualButton: false };
  }
  if (result.status === "already_claimed") {
    return { text: `${formatCard(row)}\n\n✅ *Aprobado (ya en curso)*`, offerManualButton: false };
  }
  return {
    text: `${formatCard(row)}\n\n⚠️ *Aprobado pero falló la publicación:* ${result.error.slice(0, 200)}\n\nSi la respondiste tú mismo en X, márcalo abajo.`,
    offerManualButton: true,
  };
}

/** Parse "/pause", "/pause 2h", "/pause hoy" -> a pause-until epoch (2h default; "hoy" = end of the Madrid calendar day). */
function parsePauseUntil(text: string): number {
  const nowTs = Math.floor(Date.now() / 1000);
  const arg = text.replace(/^\/pause\s*/i, "").trim().toLowerCase();
  if (arg === "hoy") {
    const madridDateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date());
    const endOfDayMadrid = new Date(`${madridDateStr}T23:59:59+02:00`); // CEST offset is close enough for a UI pause window
    return Math.floor(endOfDayMadrid.getTime() / 1000);
  }
  const hoursMatch = arg.match(/^(\d+)h$/);
  const hours = hoursMatch ? Number(hoursMatch[1]) : 2;
  return nowTs + hours * 3600;
}

/**
 * Handle one Telegram update from the webhook. Silently ignores anything
 * from a chat other than TELEGRAM_CHAT_ID (defense in depth alongside the
 * X-Telegram-Bot-Api-Secret-Token check in the route handler).
 */
export async function handleTelegramUpdate(
  env: TelegramApprovalEnv,
  db: D1Database,
  update: TelegramUpdate
): Promise<void> {
  const allowedChatId = env.TELEGRAM_CHAT_ID;

  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message?.chat.id;
    if (!allowedChatId || String(chatId) !== String(allowedChatId)) {
      await answerCallbackQuery(env, cq.id, "No autorizado");
      return;
    }
    const match = cq.data?.match(/^xq:(\d+):(approve|reject|edit|cancel|manual)$/);
    if (!match) {
      await answerCallbackQuery(env, cq.id);
      return;
    }
    const id = Number(match[1]);
    const action = match[2];
    const messageId = cq.message?.message_id;

    if (action === "approve") {
      const ok = await approveRow(db, id);
      await answerCallbackQuery(env, cq.id, ok ? "Aprobado" : "Ya no está pendiente");
      if (ok && messageId) {
        const freshRow = await getQueueRow(db, id);
        if (freshRow?.kind === "reply") {
          const outcome = await publishReplyNowAndMarkCandidate(env, db, id);
          const keyboard = outcome.offerManualButton ? [[{ text: "📋 Publicada a mano", callback_data: `xq:${id}:manual` }]] : [];
          await editXAgentMessageText(env, messageId, outcome.text, { inlineKeyboard: keyboard });
        } else {
          await editXAgentMessageText(env, messageId, `${formatCard(freshRow!)}\n\n✅ *Aprobado*`);
        }
      }
      return;
    }

    // Fase 22.4 — "published manually" (reply-guy's zero-cost preferred
    // path): Unai pasted the reply himself in X while there for the manual
    // like/follow. Marks published without ever calling the API, same as
    // the panel's "mark published" action, and records the candidate as
    // queued (a correction-rate/learning-loop signal like any other decision).
    if (action === "manual") {
      const ok = await markPublishedManual(db, id, null);
      await answerCallbackQuery(env, cq.id, ok ? "Marcado como publicado a mano" : "Ya no está disponible");
      if (ok && messageId) {
        await db.prepare("UPDATE x_reply_candidates SET status = 'queued', updated_at = ? WHERE queue_id = ?").bind(Math.floor(Date.now() / 1000), id).run();
        const row = await getQueueRow(db, id);
        await editXAgentMessageText(env, messageId, `${formatCard(row!)}\n\n📋 *Publicada a mano*`);
      }
      return;
    }

    if (action === "reject") {
      const ok = await rejectRow(db, id);
      await answerCallbackQuery(env, cq.id, ok ? "Rechazado" : "Ya no está pendiente");
      if (ok && messageId) {
        const row = await getQueueRow(db, id);
        await db.prepare("UPDATE x_reply_candidates SET status = 'skipped', updated_at = ? WHERE queue_id = ?").bind(Math.floor(Date.now() / 1000), id).run();
        await editXAgentMessageText(env, messageId, `${formatCard(row!)}\n\n❌ *Rechazado*`);
      }
      return;
    }

    if (action === "edit") {
      await answerCallbackQuery(env, cq.id, "Responde a este mensaje con el texto corregido");
      if (messageId) {
        await sendXAgentReply(env, "✏️ Responde a la tarjeta con el texto corregido y se aprobará automáticamente.", messageId);
      }
      return;
    }

    // "cancel" is the L2 veto-window button (also reachable from an L0 card,
    // where it behaves the same as reject would). cancelRow only acts on
    // scheduled/pending_approval rows, so a race with the publisher claiming
    // the row first is a harmless no-op here.
    if (action === "cancel") {
      const ok = await cancelRow(db, id);
      await answerCallbackQuery(env, cq.id, ok ? "Vetado" : "Ya no se puede cancelar (¿ya se publicó?)");
      if (ok && messageId) {
        const row = await getQueueRow(db, id);
        await editXAgentMessageText(env, messageId, `${formatCard(row!)}\n\n🚫 *Vetado — no se publicará*`);
      }
      return;
    }
    return;
  }

  if (update.message?.reply_to_message && update.message.text) {
    const chatId = update.message.chat.id;
    if (!allowedChatId || String(chatId) !== String(allowedChatId)) return;
    const repliedToId = update.message.reply_to_message.message_id;
    const row = await db
      .prepare("SELECT * FROM x_queue WHERE tg_message_id = ? AND status = 'pending_approval'")
      .bind(repliedToId)
      .first<XQueueRow>();
    if (!row) return; // reply to something else (or already resolved) — ignore
    const ok = await editAndApproveRow(db, row.id, update.message.text.trim());
    if (ok) {
      if (row.kind === "reply") {
        const outcome = await publishReplyNowAndMarkCandidate(env, db, row.id);
        const keyboard = outcome.offerManualButton ? [[{ text: "📋 Publicada a mano", callback_data: `xq:${row.id}:manual` }]] : [];
        await editXAgentMessageText(env, repliedToId, outcome.text, { inlineKeyboard: keyboard });
      } else {
        await editXAgentMessageText(env, repliedToId, `${formatCard({ ...row, text: update.message.text.trim() })}\n\n✏️ *Editado y aprobado*`);
      }
    }
    return;
  }

  // Fase 22.4 — /pause, /resume, /status: plain text commands, no reply-to needed.
  if (update.message?.text && !update.message.reply_to_message) {
    const chatId = update.message.chat.id;
    if (!allowedChatId || String(chatId) !== String(allowedChatId)) return;
    const text = update.message.text.trim();

    if (/^\/pause\b/i.test(text)) {
      const until = parsePauseUntil(text);
      await pauseDiscovery(db, until);
      const untilLabel = new Date(until * 1000).toLocaleString("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
      await sendXAgentMessage(env, `⏸ *Reply-guy pausado hasta ${untilLabel} (Madrid)*. Usa /resume para reanudar antes.`);
      return;
    }
    if (/^\/resume\b/i.test(text)) {
      await resumeDiscovery(db);
      await sendXAgentMessage(env, `▶️ *Reply-guy reanudado.*`);
      return;
    }
    if (/^\/status\b/i.test(text)) {
      const status = await getDiscoveryStatus(db);
      const pausedLabel =
        status.pausedUntil > Math.floor(Date.now() / 1000)
          ? `⏸ pausado hasta ${new Date(status.pausedUntil * 1000).toLocaleString("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })}`
          : "▶️ activo";
      await sendXAgentMessage(
        env,
        [
          `*Reply-guy status:* ${pausedLabel}`,
          `Replies hoy: ${status.counters.repliesQueued}/${status.config.dailyCap}`,
          `Gasto xAI hoy: $${status.counters.spendUsd.toFixed(3)}/$${status.config.dailyBudgetUsd.toFixed(2)}`,
          `Barridos hoy: ${status.counters.sweepsRun}`,
        ].join("\n")
      );
      return;
    }
  }
}

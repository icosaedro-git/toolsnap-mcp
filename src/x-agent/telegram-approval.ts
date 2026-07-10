/**
 * Telegram approval flow (autonomy level L0 — per-post approval) for the X
 * Agent's dedicated bot. Card has 3 buttons: Approve / Reject / Edit.
 * "Edit" doesn't open a separate state machine — the operator just replies
 * to the approval card with the corrected text; we detect that via
 * message.reply_to_message.message_id matching a pending row's
 * tg_message_id, which needs no server-side session state.
 */

import {
  sendXAgentMessage,
  editXAgentMessageText,
  answerCallbackQuery,
  sendXAgentReply,
  type XTelegramEnv,
} from "./telegram.js";
import { approveRow, cancelRow, editAndApproveRow, getQueueRow, rejectRow, type XQueueRow } from "./queue.js";

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
  return lines.join("\n");
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

/**
 * Handle one Telegram update from the webhook. Silently ignores anything
 * from a chat other than TELEGRAM_CHAT_ID (defense in depth alongside the
 * X-Telegram-Bot-Api-Secret-Token check in the route handler).
 */
export async function handleTelegramUpdate(
  env: XTelegramEnv,
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
    const match = cq.data?.match(/^xq:(\d+):(approve|reject|edit|cancel)$/);
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
        const row = await getQueueRow(db, id);
        await editXAgentMessageText(env, messageId, `${formatCard(row!)}\n\n✅ *Aprobado*`);
      }
      return;
    }

    if (action === "reject") {
      const ok = await rejectRow(db, id);
      await answerCallbackQuery(env, cq.id, ok ? "Rechazado" : "Ya no está pendiente");
      if (ok && messageId) {
        const row = await getQueueRow(db, id);
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
      await editXAgentMessageText(env, repliedToId, `${formatCard({ ...row, text: update.message.text.trim() })}\n\n✏️ *Editado y aprobado*`);
    }
  }
}

/**
 * Dedicated Telegram bot for the X Agent (Fase 22.1, decided with Unai
 * 2026-07-09) — separate from the existing alerts bot in
 * ../alerts/telegram.ts, which stays untouched (money/error channel).
 * Same chat id (TELEGRAM_CHAT_ID) but a different bot token, so channels are
 * independently mutable/mutable-away and the approval conversation (replies,
 * edits) never mixes with alert pushes.
 */

export interface XTelegramEnv {
  X_TG_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

function apiBase(env: XTelegramEnv): string | null {
  if (!env.X_TG_BOT_TOKEN) return null;
  return `https://api.telegram.org/bot${env.X_TG_BOT_TOKEN}`;
}

/** Send a message, optionally with an inline keyboard. Returns the sent message id, or null if not configured/failed. */
export async function sendXAgentMessage(
  env: XTelegramEnv,
  text: string,
  opts: { inlineKeyboard?: InlineKeyboardButton[][] } = {}
): Promise<number | null> {
  const base = apiBase(env);
  if (!base || !env.TELEGRAM_CHAT_ID) return null;
  try {
    const res = await fetch(`${base}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        ...(opts.inlineKeyboard ? { reply_markup: { inline_keyboard: opts.inlineKeyboard } } : {}),
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { result?: { message_id?: number } };
    return data.result?.message_id ?? null;
  } catch {
    return null;
  }
}

/** Edit an existing message's text (used to close out an approval card after a decision). */
export async function editXAgentMessageText(
  env: XTelegramEnv,
  messageId: number,
  text: string,
  opts: { inlineKeyboard?: InlineKeyboardButton[][] } = {}
): Promise<boolean> {
  const base = apiBase(env);
  if (!base || !env.TELEGRAM_CHAT_ID) return false;
  try {
    const res = await fetch(`${base}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        message_id: messageId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: opts.inlineKeyboard ?? [] },
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Acknowledge a callback_query (stops the client-side loading spinner on the tapped button). */
export async function answerCallbackQuery(env: XTelegramEnv, callbackQueryId: string, text?: string): Promise<void> {
  const base = apiBase(env);
  if (!base) return;
  try {
    await fetch(`${base}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
    });
  } catch {
    // best-effort
  }
}

export async function sendXAgentReply(
  env: XTelegramEnv,
  text: string,
  replyToMessageId: number
): Promise<void> {
  const base = apiBase(env);
  if (!base || !env.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`${base}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: "Markdown",
        reply_to_message_id: replyToMessageId,
      }),
    });
  } catch {
    // best-effort
  }
}

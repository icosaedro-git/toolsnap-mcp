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

/** Send a message, optionally with an inline keyboard. `plain: true` (Fase 22.4, reply-guy's copy-paste text message) omits parse_mode entirely — a draft reply can contain `_`/`*`/`` ` ``/`[` that Markdown would either mangle or reject as an unbalanced entity, and the whole point of that message is a clean, trivial copy into X. Returns the sent message id, or null if not configured/failed. */
export async function sendXAgentMessage(
  env: XTelegramEnv,
  text: string,
  opts: { inlineKeyboard?: InlineKeyboardButton[][]; plain?: boolean } = {}
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
        ...(opts.plain ? {} : { parse_mode: "Markdown" }),
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

/** Edit an existing message's text (used to close out an approval card after a decision, or to update the copy-paste text message on an edit). See sendXAgentMessage's `plain` note. */
export async function editXAgentMessageText(
  env: XTelegramEnv,
  messageId: number,
  text: string,
  opts: { inlineKeyboard?: InlineKeyboardButton[][]; plain?: boolean } = {}
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
        ...(opts.plain ? {} : { parse_mode: "Markdown" }),
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
        reply_to_message_id: replyToMessageId,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { result?: { message_id?: number } };
    return data.result?.message_id ?? null;
  } catch {
    return null; // best-effort
  }
}

/**
 * Register (or re-register) the webhook with Telegram, using the bot token
 * already stored as a Cloudflare secret — so this never requires re-sharing
 * the raw token. `secretToken` is echoed back by Telegram on every delivery
 * as X-Telegram-Bot-Api-Secret-Token (see POST /webhooks/telegram in
 * src/index.ts, which checks it against X_TG_WEBHOOK_SECRET).
 */
export async function setWebhook(
  env: XTelegramEnv,
  webhookUrl: string,
  secretToken: string
): Promise<{ ok: boolean; description?: string }> {
  const base = apiBase(env);
  if (!base) return { ok: false, description: "X_TG_BOT_TOKEN not configured" };
  const res = await fetch(`${base}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: secretToken,
      allowed_updates: ["message", "callback_query"],
    }),
  });
  return (await res.json()) as { ok: boolean; description?: string };
}

/** Diagnostic: current webhook registration state (URL, pending updates, last error). */
export async function getWebhookInfo(env: XTelegramEnv): Promise<unknown> {
  const base = apiBase(env);
  if (!base) return { ok: false, description: "X_TG_BOT_TOKEN not configured" };
  const res = await fetch(`${base}/getWebhookInfo`);
  return res.json();
}

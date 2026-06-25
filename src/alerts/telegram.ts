import type { Env } from "../index.js";

/**
 * Send a Telegram message via the Bot API. No-op (returns false) if the bot
 * token or chat id are not configured, so the scheduled handler is safe to ship
 * before the chat id is known.
 */
export async function sendTelegram(env: Env, text: string): Promise<boolean> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

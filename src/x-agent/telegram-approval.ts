/**
 * Telegram approval flow (autonomy level L0 — per-post approval) for the X
 * Agent's dedicated bot. Card has 3 buttons: Approve / Reject / Edit.
 * "Edit" doesn't open a separate state machine — the operator just replies
 * to the approval card with the corrected text; we detect that via
 * message.reply_to_message.message_id matching a pending row's
 * tg_message_id, which needs no server-side session state.
 *
 * Fase 22.4 adds reply-guy: /pause, /resume, /status text commands, and a
 * reply candidate's card is SPLIT into two Telegram messages instead of one
 * (UX fix 2026-07-11, Unai's request): a plain-text message with ONLY the
 * draft (trivial to copy — no emoji/markdown chrome in the way when
 * long-pressing "Copy" in Telegram), sent first, followed by a metadata
 * message (author/score/link + all 4 buttons: Approve API / 📋 Publicada a
 * mano / Edit / Reject). `tg_message_id` keeps meaning "the message with
 * the buttons" everywhere (unchanged for posts/quotes/threads, which still
 * get one combined message); `tg_text_message_id` (migration 0012) is the
 * new copy-paste message, NULL for every non-split row. Editing a reply
 * threads onto the TEXT message specifically — replying to either message
 * is detected (see the `tg_message_id = ? OR tg_text_message_id = ?` query
 * below), but the "✏️ Editar" button prompts a reply onto the text message
 * so the flow matches "you were about to copy this text anyway".
 *
 * This module has an intentional circular import with discovery.ts (it
 * calls pauseDiscovery/resumeDiscovery/getDiscoveryStatus; discovery.ts
 * calls sendReplyApprovalCard here) — safe because neither side touches the
 * other's exports at module-init time, only inside function bodies, which
 * ES modules resolve correctly via live bindings.
 */

import {
  sendXAgentMessage,
  editXAgentMessageText,
  answerCallbackQuery,
  sendXAgentReply,
  type XTelegramEnv,
  type InlineKeyboardButton,
} from "./telegram.js";
import { approveRow, cancelRow, editAndApproveRow, editReplyDraft, getQueueRow, markPublishedManual, now as nowTs, rejectRow, resolveQuoteTargetUrl, type XQueueRow } from "./queue.js";
import { attemptPublishNow, type PublishOneEnv } from "./publish-one.js";
import { pauseDiscovery, resumeDiscovery, getDiscoveryStatus, PAUSE_FOREVER_TS, isPausedForever } from "./discovery.js";

export interface TelegramApprovalEnv extends XTelegramEnv, PublishOneEnv {}

/**
 * Human-readable card text for a queue row — shared by the L0 approval
 * card and the L2 veto notice. `omitText` (Fase 22.4 UX fix) drops the
 * draft-text line for the META message of a split reply card, where the
 * text already lives in its own message right above and repeating it here
 * is just noise.
 */
export function formatCard(row: XQueueRow, opts: { omitText?: boolean } = {}): string {
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
  const lines = [`📝 *${accountLabel}* — ${kindLabel}${row.series ? ` (${row.series})` : ""}`];
  if (!opts.omitText) {
    lines.push(``, row.text ?? "_(sin texto — repost puro)_");
  }
  lines.push(``, `🕐 Programado: ${when}`);
  if (row.depends_on) lines.push(`↳ depende de #${row.depends_on}`);
  if (row.kind === "reply" && row.reply_to_tweet_id) {
    lines.push(`🔗 https://x.com/i/web/status/${row.reply_to_tweet_id}`);
  }
  return lines.join("\n");
}

/** Card text for editing the META/buttons message of a reply candidate or manual quote — omits the draft (it's in the separate text message above). No-op (same as formatCard) for every other row kind, which never split. */
function metaCardFor(row: XQueueRow): string {
  return formatCard(row, { omitText: row.kind === "reply" || row.kind === "quote" });
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

/** Fase 22.4 UX fix — the metadata message for a reply candidate (author/score/link); the draft text itself is a separate plain-text message sent right before this one, see sendReplyApprovalCard. */
function formatReplyMeta(info: ReplyCandidateInfo): string {
  return [
    `💬 *reply candidate* — @${info.authorHandle} (${info.authorFollowers.toLocaleString()} followers) · score ${info.score}`,
    ``,
    `🔗 ${info.tweetUrl}`,
    ``,
    `👆 texto del reply arriba, listo para copiar`,
  ].join("\n");
}

/** `https://x.com/i/web/status/<id>` for a reply row, or null if it somehow has no target (shouldn't happen — discovery.ts always sets reply_to_tweet_id for kind='reply'). */
function tweetUrlFor(row: XQueueRow): string | null {
  return row.reply_to_tweet_id ? `https://x.com/i/web/status/${row.reply_to_tweet_id}` : null;
}

/**
 * The full 4-way decision keyboard for a reply candidate — used on the
 * initial alert AND re-presented after an edit (Fase 22.4 UX fix,
 * 2026-07-11: editing no longer auto-decides "publish via API" for Unai).
 * Row 1 is a URL button (opens the original post directly, no callback) —
 * omitted if there's no link to give it.
 */
function replyDecisionKeyboard(queueId: number, tweetUrl: string | null): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [];
  if (tweetUrl) rows.push([{ text: "🔗 Abrir post", url: tweetUrl }]);
  rows.push([
    { text: "✅ Publicar (API)", callback_data: `xq:${queueId}:approve` },
    { text: "📋 Publicada a mano", callback_data: `xq:${queueId}:manual` },
  ]);
  rows.push([
    { text: "✏️ Editar", callback_data: `xq:${queueId}:edit` },
    { text: "❌ Rechazar", callback_data: `xq:${queueId}:reject` },
  ]);
  return rows;
}

/** Recovery keyboard for a failed API publish attempt — just the two things useful right there: open the post (to reply by hand) and mark it done. */
function manualRecoveryKeyboard(queueId: number, tweetUrl: string | null): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [];
  if (tweetUrl) rows.push([{ text: "🔗 Abrir post", url: tweetUrl }]);
  rows.push([{ text: "📋 Publicada a mano", callback_data: `xq:${queueId}:manual` }]);
  return rows;
}

/**
 * Keyboard for a row already marked "published manually" and waiting on the
 * real tweet URL (see markPublishedManual / tryCaptureManualTweetUrl) — just
 * the "open post" URL button so Unai can get back to the original post to
 * copy its link, or re-check the reply he just made. No callback actions
 * left to take at this point (found 2026-07-21: the previous version dropped
 * the keyboard entirely here, losing the only way back to the original post).
 */
function manualPublishedKeyboard(tweetUrl: string | null): InlineKeyboardButton[][] {
  return tweetUrl ? [[{ text: "🔗 Abrir post", url: tweetUrl }]] : [];
}

/** Decision keyboard for a manual-quote card (kind='quote') — no "Publicar (API)" option exists, X rejects automated quotes (2026-07-14 incident). */
function manualQuoteKeyboard(queueId: number, quoteUrl: string | null): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [];
  if (quoteUrl) rows.push([{ text: "🔗 Abrir post", url: quoteUrl }]);
  rows.push([
    { text: "📋 Publicada a mano", callback_data: `xq:${queueId}:manual` },
    { text: "❌ Rechazar", callback_data: `xq:${queueId}:reject` },
  ]);
  return rows;
}

/** Meta message text for a manual-quote card. */
function formatManualQuoteMeta(row: XQueueRow, quoteUrl: string | null): string {
  const accountLabel = row.account === "product" ? "@ToolSnapMCP" : "@icosaedro_one";
  const lines = [
    `🔁 *quote manual* — ${accountLabel} cita a${quoteUrl ? ` ${quoteUrl}` : " (post desconocido)"}`,
    ``,
    `⚠️ La API de X no permite citar posts de forma automatizada (restricción de plataforma, no de config de cuenta) — públicala tú mismo copiando el texto de arriba.`,
    ``,
    `👆 texto listo para copiar arriba`,
  ];
  return lines.join("\n");
}

/**
 * Send a manual-publish card for a `kind='quote'` row (Fase 22.5 — X's API
 * 403s every automated quote, see divertQuoteToManual in publisher.ts). Same
 * split-message pattern as sendReplyApprovalCard: a copy-paste-only text
 * message, then a metadata message with the link to the post being quoted
 * and a decision keyboard (published by hand / reject — no API option).
 */
export async function sendManualQuoteCard(env: XTelegramEnv, db: D1Database, row: XQueueRow, quoteUrl: string | null): Promise<void> {
  const textMessageId = await sendXAgentMessage(env, row.text ?? "", { format: "code" });
  const metaMessageId = await sendXAgentMessage(env, formatManualQuoteMeta(row, quoteUrl), {
    inlineKeyboard: manualQuoteKeyboard(row.id, quoteUrl),
  });
  if (textMessageId || metaMessageId) {
    await db
      .prepare("UPDATE x_queue SET tg_text_message_id = ?, tg_message_id = ? WHERE id = ?")
      .bind(textMessageId, metaMessageId, row.id)
      .run();
  }
}

const TWEET_URL_ID_RE = /status\/(\d+)/;

/**
 * Fase 22.5 — after "📋 Publicada a mano" (quotes, replies, or a panel-side
 * failed-row recovery), the row is `published` with `tweet_id` still NULL:
 * Unai posted it himself, so there's no id from an API response. Metrics
 * (getRecentPublishedRowsWithTweetId) can only pick the row up once a real
 * tweet_id is set. This is the other half of that flow: a reply to the
 * "responde con la URL" card carrying an x.com/status/<id> link gets parsed
 * and written back. No-ops (silently) if repliedToId doesn't match any such
 * row or the text has no tweet id in it — could be an unrelated reply.
 */
async function tryCaptureManualTweetUrl(env: XTelegramEnv, db: D1Database, repliedToId: number, text: string): Promise<void> {
  const row = await db
    .prepare("SELECT * FROM x_queue WHERE (tg_message_id = ? OR tg_text_message_id = ?) AND status = 'published' AND tweet_id IS NULL")
    .bind(repliedToId, repliedToId)
    .first<XQueueRow>();
  if (!row) return;

  const match = text.match(TWEET_URL_ID_RE);
  if (!match) {
    await sendXAgentReply(env, "No he podido leer un id de tweet ahí — responde con la URL completa de x.com/status/…", repliedToId);
    return;
  }

  // 2026-07-21 hardening — the original post's link sits right above in the
  // same card (row.reply_to_tweet_id for a reply, row.quote_tweet_id for a
  // quote), so it's an easy paste mistake to grab that link instead of the
  // one for the reply Unai actually just posted. Recording it as tweet_id
  // would silently attribute the original author's post to Unai's own
  // metrics — reject it instead of writing it.
  if (match[1] === row.reply_to_tweet_id || match[1] === row.quote_tweet_id) {
    await sendXAgentReply(env, "Ese es el link del post original, no el de tu respuesta — pega la URL de tu propio tweet.", repliedToId);
    return;
  }

  await db.prepare("UPDATE x_queue SET tweet_id = ?, updated_at = ? WHERE id = ?").bind(match[1], nowTs(), row.id).run();
  const messageId = row.tg_message_id ?? repliedToId;
  const tweetUrl = `https://x.com/i/web/status/${match[1]}`;
  await editXAgentMessageText(
    env,
    messageId,
    `${metaCardFor({ ...row, tweet_id: match[1] })}\n\n📋 *Publicada a mano*\n✅ *URL registrada — entrará en métricas*`,
    { inlineKeyboard: manualPublishedKeyboard(tweetUrl) }
  );
}

/**
 * Send the alert for a discovered reply candidate (Fase 22.4) as TWO
 * messages (UX fix 2026-07-11): first a code-block message with only the
 * draft — Telegram copies a `<pre>` block's full contents with a single
 * tap, and the escaped HTML means the draft always renders/copies
 * byte-for-byte regardless of `_`/`*`/`` ` ``/`[` in the text — then a
 * metadata message (author/score/link) with the full decision keyboard:
 * open post / Approve via API / 📋 published manually (Unai pasted it
 * himself — zero API cost, the preferred path since he's already there for
 * the manual like/follow) / Edit / Reject.
 */
export async function sendReplyApprovalCard(env: XTelegramEnv, db: D1Database, info: ReplyCandidateInfo): Promise<void> {
  const textMessageId = await sendXAgentMessage(env, info.draftReply, { format: "code" });
  const metaMessageId = await sendXAgentMessage(env, formatReplyMeta(info), {
    inlineKeyboard: replyDecisionKeyboard(info.queueId, info.tweetUrl),
  });
  if (textMessageId || metaMessageId) {
    await db
      .prepare("UPDATE x_queue SET tg_text_message_id = ?, tg_message_id = ? WHERE id = ?")
      .bind(textMessageId, metaMessageId, info.queueId)
      .run();
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

interface TelegramMessage {
  message_id: number;
  text?: string;
  chat: { id: number };
  reply_to_message?: { message_id: number };
}

export interface TelegramUpdate {
  message?: TelegramMessage;
  // Telegram sends this instead of `message` when Unai edits a message he
  // already sent (native Telegram "Edit" on his own reply) rather than
  // sending a new one — found 2026-07-21: this went unhandled entirely, so
  // editing a reply-to-the-card via Telegram's own edit silently did nothing.
  edited_message?: TelegramMessage;
  callback_query?: {
    id: string;
    data?: string;
    message?: { message_id: number; chat: { id: number } };
  };
}

interface ReplyPublishOutcome {
  text: string;
  /** Empty when the outcome is final (published, or already in flight) — otherwise the recovery keyboard for a failed API attempt (found 2026-07-11: a real X 403 — "not allowed to reply unless mentioned/engaged by the author" — left the row `failed` with no button on the card to recover it). */
  keyboard: InlineKeyboardButton[][];
}

/**
 * Publish a `kind='reply'` row right away via the X API (called only when
 * Unai has explicitly chosen "✅ Publicar (API)" — never as a side effect of
 * editing, see editReplyDraft) instead of waiting for the next cron tick —
 * timing is the whole point of a reply (nota 14 §1/§5). Marks the
 * associated candidate 'queued' either way. On any outcome other than a
 * real publish, the card gets the manual-recovery keyboard — X can
 * legitimately reject a reply (conversation restricted to mentioned/engaged
 * accounts) and that's not a bug to retry, it's Unai doing it by hand instead.
 */
async function publishReplyNowAndMarkCandidate(env: TelegramApprovalEnv, db: D1Database, id: number): Promise<ReplyPublishOutcome> {
  const row = await getQueueRow(db, id);
  await db.prepare("UPDATE x_reply_candidates SET status = 'queued', updated_at = ? WHERE queue_id = ?").bind(Math.floor(Date.now() / 1000), id).run();
  if (!row) return { text: "❌ *Error: fila no encontrada*", keyboard: [] };
  const tweetUrl = tweetUrlFor(row);
  const result = await attemptPublishNow(env, row);
  if (result.status === "published") {
    return { text: `${metaCardFor({ ...row, status: "published", tweet_id: result.tweetId })}\n\n✅ *Publicado*`, keyboard: [] };
  }
  if (result.status === "already_claimed") {
    return { text: `${metaCardFor(row)}\n\n✅ *Aprobado (ya en curso)*`, keyboard: [] };
  }
  return {
    text: `${metaCardFor(row)}\n\n⚠️ *Aprobado pero falló la publicación:* ${result.error.slice(0, 200)}\n\nSi la respondiste tú mismo en X, márcalo abajo.`,
    keyboard: manualRecoveryKeyboard(id, tweetUrl),
  };
}

/**
 * Discovery status text — shared by the `/status` command and the
 * `xr:` callback handlers that re-render it in place after a button tap
 * (Fase 22.4 discoverability fix, 2026-07-11).
 */
function fmtMadridHHMM(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit" });
}

/** Suffix for the "Hoy" line explaining why (not) — only for the non-obvious states; paused/stopped are already covered by the top line. */
function todaySuffix(today: Awaited<ReturnType<typeof getDiscoveryStatus>>["today"]): string {
  if (today.state === "active") {
    return today.nextSweepEarliest ? ` · próximo no antes de las ${fmtMadridHHMM(today.nextSweepEarliest)}` : "";
  }
  if (today.state === "off_today") return " · sin barridos hoy por diseño";
  if (today.state === "quota_done") return " · barridos de hoy completados";
  if (today.state === "budget_reached") return " · presupuesto diario agotado";
  if (today.state === "cap_reached") return " · cap diario alcanzado";
  return "";
}

function formatDiscoveryStatus(status: Awaited<ReturnType<typeof getDiscoveryStatus>>): string {
  const pausedLabel = isPausedForever(status.pausedUntil)
    ? "⏹ detenido (permanente — /resume para reanudar)"
    : status.pausedUntil > Math.floor(Date.now() / 1000)
    ? `⏸ pausado hasta ${new Date(status.pausedUntil * 1000).toLocaleString("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })}`
    : "▶️ activo";
  const weekLine = status.week
    .map((d) => (d.isToday ? `[${d.label}${d.sweeps || "—"}]` : `${d.label}${d.sweeps || "—"}`))
    .join(" · ");
  return [
    `*Reply-guy status:* ${pausedLabel}`,
    `Hoy (${status.today.dayLabel}): ${status.today.sweepsDone}/${status.today.targetSweeps} barridos · ventana ${status.today.windowStartHour}–${status.today.windowEndHour}h${todaySuffix(status.today)}`,
    `Semana: ${weekLine}`,
    `Replies hoy: ${status.counters.repliesQueued}/${status.config.dailyCap}`,
    `Gasto xAI hoy: $${status.counters.spendUsd.toFixed(3)}/$${status.config.dailyBudgetUsd.toFixed(2)}`,
  ].join("\n");
}

/**
 * Contextual control keyboard for the `/status` message — only the actions
 * that make sense given the current pause state, so `/status` doubles as a
 * live mini-panel: paused/stopped shows "▶️ Reanudar"; active shows
 * "⏸ Pausa 2h" + "⏹ Stop". Callback prefix `xr:` ("x reply-guy control") is
 * deliberately distinct from `xq:<id>:<action>` (which always carries a
 * queue row id) — no id needed here, there's only one discovery state.
 */
function discoveryControlKeyboard(pausedUntil: number): InlineKeyboardButton[][] {
  if (pausedUntil > Math.floor(Date.now() / 1000)) {
    return [[{ text: "▶️ Reanudar", callback_data: "xr:resume" }]];
  }
  return [
    [
      { text: "⏸ Pausa 2h", callback_data: "xr:pause2h" },
      { text: "⏹ Stop", callback_data: "xr:stop" },
    ],
  ];
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
  // Treat a native Telegram edit of Unai's own message the same as a fresh
  // one (2026-07-21 fix) — Telegram delivers that as `edited_message`, never
  // `message`, so without this an in-place edit of a reply-to-the-card was
  // silently dropped.
  const msg = update.message ?? update.edited_message;

  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message?.chat.id;
    if (!allowedChatId || String(chatId) !== String(allowedChatId)) {
      await answerCallbackQuery(env, cq.id, "No autorizado");
      return;
    }
    // Fase 22.4 discoverability fix (2026-07-11): the `/status` control
    // keyboard's buttons — pause 2h / stop / resume, no queue row id
    // involved (see discoveryControlKeyboard's doc comment). Checked before
    // the `xq:` match since the prefixes are disjoint by construction.
    const controlMatch = cq.data?.match(/^xr:(pause2h|stop|resume)$/);
    if (controlMatch) {
      const controlAction = controlMatch[1];
      if (controlAction === "pause2h") {
        await pauseDiscovery(db, Math.floor(Date.now() / 1000) + 2 * 3600);
        await answerCallbackQuery(env, cq.id, "Pausado 2h");
      } else if (controlAction === "stop") {
        await pauseDiscovery(db, PAUSE_FOREVER_TS);
        await answerCallbackQuery(env, cq.id, "Detenido");
      } else {
        await resumeDiscovery(db);
        await answerCallbackQuery(env, cq.id, "Reanudado");
      }
      const messageId = cq.message?.message_id;
      if (messageId) {
        const status = await getDiscoveryStatus(db);
        await editXAgentMessageText(env, messageId, formatDiscoveryStatus(status), {
          inlineKeyboard: discoveryControlKeyboard(status.pausedUntil),
        });
      }
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
          await editXAgentMessageText(env, messageId, outcome.text, { inlineKeyboard: outcome.keyboard });
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
        // tweet_id is still NULL at this point (markPublishedManual was
        // called with tweetId=null) — ask for the real URL so metrics can
        // pick this row up (Fase 22.5, see the reply_to_message handler
        // below for where the answer gets parsed). Keep the "open post"
        // button alive (2026-07-21 fix) — losing it here stranded Unai with
        // no way back to the original post once he'd marked it manual.
        const tweetUrl = tweetUrlFor(row!);
        await editXAgentMessageText(
          env,
          messageId,
          `${metaCardFor(row!)}\n\n📋 *Publicada a mano* — responde a este mensaje con la URL del tweet para activar métricas.`,
          { inlineKeyboard: manualPublishedKeyboard(tweetUrl) }
        );
      }
      return;
    }

    if (action === "reject") {
      const ok = await rejectRow(db, id);
      await answerCallbackQuery(env, cq.id, ok ? "Rechazado" : "Ya no está pendiente");
      if (ok && messageId) {
        const row = await getQueueRow(db, id);
        await db.prepare("UPDATE x_reply_candidates SET status = 'skipped', updated_at = ? WHERE queue_id = ?").bind(Math.floor(Date.now() / 1000), id).run();
        await editXAgentMessageText(env, messageId, `${metaCardFor(row!)}\n\n❌ *Rechazado*`);
      }
      return;
    }

    if (action === "edit") {
      // Fase 22.4 UX fix: thread the "reply with the correction" prompt onto
      // the TEXT message specifically (tg_text_message_id) when this is a
      // split reply card — that's the message Unai was about to copy from
      // anyway, so correcting it is the same gesture. Falls back to the
      // single combined message (messageId, the one the button lives on)
      // for every non-split row kind, unchanged from before the split.
      const row = await getQueueRow(db, id);
      const targetMessageId = row?.tg_text_message_id ?? messageId;
      await answerCallbackQuery(env, cq.id, "Responde con el texto corregido");
      if (targetMessageId) {
        await sendXAgentReply(env, "✏️ Responde a *este* mensaje con el texto corregido y se aprobará automáticamente.", targetMessageId);
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
        await editXAgentMessageText(env, messageId, `${metaCardFor(row!)}\n\n🚫 *Vetado — no se publicará*`);
      }
      return;
    }
    return;
  }

  if (msg?.reply_to_message && msg.text) {
    const chatId = msg.chat.id;
    if (!allowedChatId || String(chatId) !== String(allowedChatId)) return;
    const repliedToId = msg.reply_to_message.message_id;
    // Fase 22.4 UX fix: a split reply/quote card can be replied-to via either
    // message (the text one, which is what the "✏️ Editar" prompt threads
    // onto, or the meta/buttons one, for anyone who habitually replies to
    // the card like before) — match whichever matches.
    const row = await db
      .prepare("SELECT * FROM x_queue WHERE (tg_message_id = ? OR tg_text_message_id = ?) AND status = 'pending_approval'")
      .bind(repliedToId, repliedToId)
      .first<XQueueRow>();

    if (!row) {
      // Fase 22.5 — no pending row matched: maybe this is a reply to an
      // already-"published manually" card (tweet_id still NULL) carrying the
      // real tweet URL, so metrics can pick it up.
      const replyText = msg.text.trim();
      if (!TWEET_URL_ID_RE.test(replyText)) {
        // 2026-07-21 fix — no tweet URL in the text either, so this isn't a
        // metrics-capture reply: most likely Unai tried to correct a draft
        // whose card already left pending_approval (approved/published/
        // rejected/etc). The old behavior fell straight into
        // tryCaptureManualTweetUrl's generic "can't read a tweet id" message,
        // which was confusing when the real problem is "there's nothing left
        // to edit here". Look up the row (by either message id) regardless of
        // status so the reply names the actual state.
        const anyRow = await db
          .prepare("SELECT * FROM x_queue WHERE tg_message_id = ? OR tg_text_message_id = ?")
          .bind(repliedToId, repliedToId)
          .first<XQueueRow>();
        if (anyRow) {
          await sendXAgentReply(
            env,
            `Esa card ya no está pendiente (estado: ${anyRow.status}). Para editar el borrador tiene que estar pendiente de aprobación.`,
            repliedToId
          );
          return;
        }
      }
      await tryCaptureManualTweetUrl(env, db, repliedToId, replyText);
      return;
    }
    const newText = msg.text.trim();

    // Fase 22.4 UX fix (2026-07-11): editing a reply no longer auto-publishes
    // via API — it corrects the draft and hands the decision (API / manual /
    // reject) back to Unai, same as a fresh candidate. His primary path is
    // manual anyway, and the API can legitimately 403 on a restricted
    // conversation; deciding "publish via API" for him on every edit was the
    // wrong default. Fase 22.5 extends the same "edit doesn't auto-decide"
    // behavior to kind='quote' — quotes have no API path at all now (see
    // divertQuoteToManual in publisher.ts), so editAndApproveRow (which
    // would send it back to 'scheduled' for the cron to re-divert, sending a
    // duplicate card) is wrong here too. Every other row kind
    // (posts/threads/reposts) keeps editAndApproveRow's behavior — edit =
    // approve — unchanged.
    if (row.kind === "reply") {
      const ok = await editReplyDraft(db, row.id, newText);
      if (ok) {
        // Both messages must never show mismatched text: update the
        // copy-paste text message to the correction first...
        if (row.tg_text_message_id) {
          await editXAgentMessageText(env, row.tg_text_message_id, newText, { format: "code" });
        }
        // ...then re-present the full decision keyboard on the meta message.
        if (row.tg_message_id) {
          const tweetUrl = tweetUrlFor(row);
          await editXAgentMessageText(
            env,
            row.tg_message_id,
            `${metaCardFor({ ...row, text: newText })}\n\n✏️ *Texto actualizado — elige cómo publicar*`,
            { inlineKeyboard: replyDecisionKeyboard(row.id, tweetUrl) }
          );
        }
      }
    } else if (row.kind === "quote") {
      const ok = await editReplyDraft(db, row.id, newText);
      if (ok) {
        if (row.tg_text_message_id) {
          await editXAgentMessageText(env, row.tg_text_message_id, newText, { format: "code" });
        }
        if (row.tg_message_id) {
          const quoteUrl = await resolveQuoteTargetUrl(db, row);
          await editXAgentMessageText(
            env,
            row.tg_message_id,
            `${formatManualQuoteMeta({ ...row, text: newText }, quoteUrl)}\n\n✏️ *Texto actualizado*`,
            { inlineKeyboard: manualQuoteKeyboard(row.id, quoteUrl) }
          );
        }
      }
    } else {
      const ok = await editAndApproveRow(db, row.id, newText);
      if (ok) {
        await editXAgentMessageText(env, repliedToId, `${formatCard({ ...row, text: newText })}\n\n✏️ *Editado y aprobado*`);
      }
    }
    return;
  }

  // Fase 22.4 — /pause, /resume, /status: plain text commands, no reply-to needed.
  if (msg?.text && !msg.reply_to_message) {
    const chatId = msg.chat.id;
    if (!allowedChatId || String(chatId) !== String(allowedChatId)) return;
    const text = msg.text.trim();

    if (/^\/pause\b/i.test(text)) {
      const until = parsePauseUntil(text);
      await pauseDiscovery(db, until);
      const untilLabel = new Date(until * 1000).toLocaleString("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
      await sendXAgentMessage(env, `⏸ *Reply-guy pausado hasta ${untilLabel} (Madrid)*. Usa /resume para reanudar antes.`);
      return;
    }
    // Fase 22.4 UX fix (2026-07-11) — /stop: pause indefinitely, distinct
    // from /pause's timed windows. Same mechanism (pauseDiscovery), just the
    // PAUSE_FOREVER_TS sentinel instead of a real epoch.
    if (/^\/stop\b/i.test(text)) {
      await pauseDiscovery(db, PAUSE_FOREVER_TS);
      await sendXAgentMessage(env, `⏹ *Reply-guy detenido.* No se reanudará hasta que envíes /resume.`);
      return;
    }
    if (/^\/resume\b/i.test(text)) {
      await resumeDiscovery(db);
      await sendXAgentMessage(env, `▶️ *Reply-guy reanudado.*`);
      return;
    }
    if (/^\/status\b/i.test(text)) {
      const status = await getDiscoveryStatus(db);
      await sendXAgentMessage(env, formatDiscoveryStatus(status), {
        inlineKeyboard: discoveryControlKeyboard(status.pausedUntil),
      });
      return;
    }
  }
}

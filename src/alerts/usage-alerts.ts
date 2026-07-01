import type { Env } from "../index.js";
import { sendTelegram } from "./telegram.js";

/**
 * Usage alerts for COGS tools backed by an external provider with a free-tier
 * quota (screenshot_url → ScreenshotOne, 100/month free, break-even ~135/month).
 *
 * Run daily by a Cron Trigger. It:
 *  - counts this month's executed screenshot_url calls,
 *  - fires a Telegram alert when usage crosses 50 / 90 / 100 (each once per
 *    month, de-duped via KV), so we get an early heads-up and a near-limit
 *    warning in time to decide on Workers Paid / overage,
 *  - on Mondays, sends a weekly usage digest.
 *
 * Safe before configuration: sendTelegram no-ops without bot token + chat id.
 */

const FREE_TIER = 100; // ScreenshotOne free screenshots / month
const BREAK_EVEN = 135; // monthly paid calls that cover Workers Paid $5/mo
const THRESHOLDS = [50, 90, 100];
const KV_TTL_SEC = 45 * 24 * 60 * 60;
// 2 years — the panel now shows a 1y timeframe and we want history to grow
// into it. D1 free tier is 5 GB (~25M rows at ~200 B/row); even sustained
// high traffic (~34k calls/day) wouldn't fill that in 2 years, and by then
// the revenue implied would make Workers Paid a non-issue.
const ANALYTICS_RETENTION_MS = 730 * 24 * 60 * 60 * 1000;

/** Payment types that mean the tool actually executed (hit the provider). */
const EXECUTED_TYPES = ["x402_paid", "prepaid", "free_tool", "x402_free_first"];

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function startOfMonthMs(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** Count this month's executed screenshot_url calls. */
async function monthScreenshotCount(env: Env, now: Date): Promise<number> {
  const placeholders = EXECUTED_TYPES.map(() => "?").join(",");
  const row = await env.PREPAID_DB.prepare(
    `SELECT count(*) AS n FROM analytics_events
     WHERE tool_name = 'screenshot_url'
       AND ts >= ?
       AND payment_type IN (${placeholders})`
  )
    .bind(startOfMonthMs(now), ...EXECUTED_TYPES)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Delete R2 objects under the given prefix that are older than maxAgeMs. */
async function purgeOldR2Objects(
  bucket: R2Bucket,
  prefix: string,
  maxAgeMs: number,
  now: Date
): Promise<number> {
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const obj of listed.objects) {
      if (now.getTime() - obj.uploaded.getTime() > maxAgeMs) {
        await bucket.delete(obj.key);
        deleted++;
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return deleted;
}

export async function checkUsageAlerts(env: Env, now: Date = new Date()): Promise<void> {
  // Purge temporary R2 files older than 24 h.
  const TTL_24H = 24 * 60 * 60 * 1000;
  await Promise.all([
    purgeOldR2Objects(env.SCREENSHOTS_BUCKET, "rembg/", TTL_24H, now),
    purgeOldR2Objects(env.SCREENSHOTS_BUCKET, "uploads/", TTL_24H, now),
  ]);

  // Retention: drop analytics_events older than 90 days (money ledger tables
  // are untouched — this only trims the append-only telemetry log).
  await env.PREPAID_DB.prepare(`DELETE FROM analytics_events WHERE ts < ?`)
    .bind(now.getTime() - ANALYTICS_RETENTION_MS)
    .run()
    .catch(() => {
      // Retention is best-effort — never let it break the alerts cron.
    });
  const count = await monthScreenshotCount(env, now);
  const month = monthKey(now);

  // Threshold crossings — each fires once per month.
  for (const t of THRESHOLDS) {
    if (count < t) continue;
    const flagKey = `alert:screenshot:${month}:${t}`;
    const already = await env.X402_NONCES.get(flagKey);
    if (already) continue;
    await env.X402_NONCES.put(flagKey, new Date().toISOString(), {
      expirationTtl: KV_TTL_SEC,
    });
    let msg: string;
    if (t >= FREE_TIER) {
      msg = `🔴 *ToolSnap* — screenshot_url ha llegado a *${count}* este mes (${month}).\nFree tier de ScreenshotOne (${FREE_TIER}/mes) AGOTADO → ahora pagas overage (~$0.009/captura). Break-even Workers Paid: ${BREAK_EVEN}/mes. Considera activar self-host (camino A).`;
    } else if (t >= 90) {
      msg = `🟠 *ToolSnap* — screenshot_url va por *${count}* este mes (${month}).\nCerca del free tier (${FREE_TIER}/mes). Decide pronto: seguir con overage o activar Workers Paid + self-host.`;
    } else {
      msg = `🟢 *ToolSnap* — screenshot_url va por *${count}* este mes (${month}).\nAviso temprano (umbral ${t}). Queda margen hasta el free tier (${FREE_TIER}/mes).`;
    }
    await sendTelegram(env, msg);
  }

  // Weekly digest on Mondays.
  if (now.getUTCDay() === 1) {
    const digestKey = `digest:screenshot:${month}:w${weekOfMonth(now)}`;
    const sent = await env.X402_NONCES.get(digestKey);
    if (!sent) {
      await env.X402_NONCES.put(digestKey, "1", { expirationTtl: KV_TTL_SEC });
      const remaining = Math.max(0, FREE_TIER - count);
      await sendTelegram(
        env,
        `📊 *ToolSnap — resumen semanal* (${month})\nscreenshot_url este mes: *${count}*\nQuedan ~*${remaining}* del free tier (${FREE_TIER}/mes).\nBreak-even Workers Paid: ${BREAK_EVEN}/mes.`
      );
    }
  }
}

function weekOfMonth(d: Date): number {
  return Math.ceil(d.getUTCDate() / 7);
}

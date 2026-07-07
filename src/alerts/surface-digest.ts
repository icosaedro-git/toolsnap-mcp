import type { Env } from "../index.js";
import { getWeeklySurfaceDigest } from "../analytics/queries.js";
import { sendTelegram } from "./telegram.js";

/**
 * Weekly "which surface converts" digest (Fase 24.3) — connections, calls,
 * revenue by MCP client (Claude Desktop, Claude Code, mcp-remote, ...),
 * this week vs last week. Sent Mondays, deduped via KV like the existing
 * screenshot-quota digest in usage-alerts.ts. Safe before configuration:
 * sendTelegram no-ops without bot token + chat id.
 */

const KV_TTL_SEC = 45 * 24 * 60 * 60;

function weekOfMonth(d: Date): number {
  return Math.ceil(d.getUTCDate() / 7);
}

function pctDelta(current: number, previous: number): string {
  if (previous === 0) return current > 0 ? "(new)" : "";
  const pct = Math.round(((current - previous) / previous) * 100);
  const arrow = pct >= 0 ? "▲" : "▼";
  return `(${arrow}${Math.abs(pct)}%)`;
}

export async function checkSurfaceDigest(env: Env, now: Date = new Date()): Promise<void> {
  if (now.getUTCDay() !== 1) return; // Mondays only

  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const digestKey = `digest:surface:${month}:w${weekOfMonth(now)}`;
  const sent = await env.X402_NONCES.get(digestKey);
  if (sent) return;
  await env.X402_NONCES.put(digestKey, "1", { expirationTtl: KV_TTL_SEC });

  const d = await getWeeklySurfaceDigest(env.PREPAID_DB, now.getTime());

  const lastByClient = new Map(d.connects_last_week.map((r) => [r.client, r.connects]));
  const connectLines = d.connects_this_week.length
    ? d.connects_this_week
        .map((r) => `  • ${r.client}: *${r.connects}* ${pctDelta(r.connects, lastByClient.get(r.client) ?? 0)}`)
        .join("\n")
    : "  (sin conexiones nuevas esta semana)";

  const callsByClient = d.calls_this_week.length
    ? d.calls_this_week.map((r) => `  • ${r.client}: ${r.calls}`).join("\n")
    : "  (sin llamadas esta semana)";

  const topTools = d.top_tools_this_week.length
    ? d.top_tools_this_week.map((r) => `${r.tool} (${r.calls})`).join(", ")
    : "—";

  const conversionPct =
    d.total_calls_this_week > 0 ? Math.round((d.paid_calls_this_week / d.total_calls_this_week) * 100) : 0;

  const msg = [
    `📊 *ToolSnap — resumen semanal de superficie* (${month}, semana ${weekOfMonth(now)})`,
    ``,
    `*Conexiones nuevas por superficie:*`,
    connectLines,
    ``,
    `*Llamadas por superficie:*`,
    callsByClient,
    ``,
    `Llamadas totales: *${d.total_calls_this_week}* ${pctDelta(d.total_calls_this_week, d.total_calls_last_week)} vs semana anterior (${d.total_calls_last_week})`,
    `Revenue: *$${d.total_revenue_this_week.toFixed(4)}*`,
    `Conversión free→paid: *${conversionPct}%* (${d.paid_calls_this_week}/${d.total_calls_this_week})`,
    `Top tools: ${topTools}`,
  ].join("\n");

  await sendTelegram(env, msg);
}

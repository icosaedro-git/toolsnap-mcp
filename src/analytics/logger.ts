/**
 * Analytics event writer — persists to D1 (analytics_events table).
 *
 * Writes are fire-and-forget (wrapped in try/catch) so they never fail
 * the main request. The table is created by migration 0002_analytics.sql.
 */

import { maybeAlertError, maybeAlertBusinessSignal } from "../alerts/error-alerts.js";

export type PaymentType =
  // Fase 24 — one per successful MCP `initialize` (a new connection/session).
  | "connect"
  | "free_tool"
  | "x402_paid"
  | "x402_free_first"
  | "prepaid"
  | "402_rejected"
  | "prepaid_insufficient"
  | "prepaid_rejected"
  | "deposit_success"
  | "deposit_failed"
  | "settle_failed"
  | "tool_error"
  // Fase 17 — fiat rail (API key + Polar).
  | "api_key"
  | "api_key_insufficient"
  | "api_key_rejected"
  | "fiat_deposit_success"
  | "fiat_deposit_failed"
  // A webhook delivery that isn't order.paid (e.g. order.created) — benign,
  // not an error; distinct from fiat_deposit_failed so it never pages anyone.
  | "fiat_webhook_ignored"
  // Fase 26 — OAuth 2.1 rail (same account/balance as api_key, different door).
  | "oauth"
  | "oauth_insufficient"
  | "oauth_rejected";

/** Payment types that represent a failure worth surfacing in logs/panel. */
const ERROR_PAYMENT_TYPES: ReadonlySet<PaymentType> = new Set([
  "402_rejected",
  "prepaid_insufficient",
  "prepaid_rejected",
  "deposit_failed",
  "settle_failed",
  "tool_error",
  "api_key_insufficient",
  "api_key_rejected",
  "fiat_deposit_failed",
  "oauth_insufficient",
  "oauth_rejected",
]);

const MAX_DETAIL_LEN = 500;

export interface AnalyticsEvent {
  toolName: string;
  paymentType: PaymentType;
  payer: string;
  revenueUsdc: number;
  latencyMs: number;
  /** Human-readable reason for a failed/rejected event (error message, reject reason). */
  detail?: string;
  /** Caller's User-Agent header — identifies which MCP client made the call. */
  client?: string;
  /** True when the call was flagged as our own dev/testing traffic (X-ToolSnap-Internal header). */
  internal?: boolean;
  /** Normalized client surface (Fase 24) — e.g. "claude-desktop", "claude-code", "mcp-remote". See src/analytics/surface.ts. */
  clientName?: string | null;
  /** Client version, when the MCP clientInfo provided one. */
  clientVersion?: string | null;
  /** Mcp-Session-Id (Fase 24) — enables the per-session CP-tarea-completa funnel. Not a human identity. */
  sessionId?: string | null;
}

export interface AnalyticsEnv {
  PREPAID_DB: D1Database;
  X402_NONCES?: KVNamespace;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  /** Comma-separated EVM addresses of our own wallets — their calls are marked internal. */
  INTERNAL_WALLETS?: string;
}

/** A call is internal when explicitly flagged, admin-bypassed, or paid by one of our own wallets. */
function isInternalEvent(env: AnalyticsEnv, event: AnalyticsEvent): boolean {
  if (event.internal) return true;
  if (event.payer === "admin") return true;
  if (env.INTERNAL_WALLETS && event.payer) {
    const own = env.INTERNAL_WALLETS.split(",").map((a) => a.trim().toLowerCase());
    return own.includes(event.payer.toLowerCase());
  }
  return false;
}

export function writeEvent(
  env: AnalyticsEnv,
  event: AnalyticsEvent,
  ctx: ExecutionContext
): void {
  const detail = event.detail ? event.detail.slice(0, MAX_DETAIL_LEN) : null;

  if (ERROR_PAYMENT_TYPES.has(event.paymentType)) {
    console.error(
      JSON.stringify({
        event: event.paymentType,
        tool: event.toolName,
        payer: event.payer,
        client: event.client ?? null,
        detail,
      })
    );
    maybeAlertError(env, ctx, {
      toolName: event.toolName,
      paymentType: event.paymentType,
      payer: event.payer,
      client: event.client,
      detail,
    });
  }

  // Fase 24.7 — positive/actionable business signals (credit purchases,
  // first paid call, no-balance) run independently of ERROR_PAYMENT_TYPES —
  // most of these payment_types aren't failures.
  maybeAlertBusinessSignal(env, ctx, {
    toolName: event.toolName,
    paymentType: event.paymentType,
    payer: event.payer,
    revenueUsdc: event.revenueUsdc,
    client: event.client,
    detail,
  });

  // Must use ctx.waitUntil — otherwise Cloudflare Workers kills the D1 write
  // before the async op completes (fire-and-forget without waitUntil is a no-op).
  ctx.waitUntil(
    env.PREPAID_DB.prepare(
      `INSERT INTO analytics_events (ts, tool_name, payment_type, payer, revenue_usdc, latency_ms, detail, client, internal, client_name, client_version, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        Date.now(),
        event.toolName,
        event.paymentType,
        event.payer,
        event.revenueUsdc,
        event.latencyMs,
        detail,
        event.client ?? null,
        isInternalEvent(env, event) ? 1 : 0,
        event.clientName ?? null,
        event.clientVersion ?? null,
        event.sessionId ?? null
      )
      .run()
      .catch(() => {
        // Silently swallow — analytics must never break tool calls
      })
  );
}

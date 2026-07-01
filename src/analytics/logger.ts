/**
 * Analytics event writer — persists to D1 (analytics_events table).
 *
 * Writes are fire-and-forget (wrapped in try/catch) so they never fail
 * the main request. The table is created by migration 0002_analytics.sql.
 */

import { maybeAlertError } from "../alerts/error-alerts.js";

export type PaymentType =
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
  | "tool_error";

/** Payment types that represent a failure worth surfacing in logs/panel. */
const ERROR_PAYMENT_TYPES: ReadonlySet<PaymentType> = new Set([
  "402_rejected",
  "prepaid_insufficient",
  "prepaid_rejected",
  "deposit_failed",
  "settle_failed",
  "tool_error",
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
}

export interface AnalyticsEnv {
  PREPAID_DB: D1Database;
  X402_NONCES?: KVNamespace;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
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

  // Must use ctx.waitUntil — otherwise Cloudflare Workers kills the D1 write
  // before the async op completes (fire-and-forget without waitUntil is a no-op).
  ctx.waitUntil(
    env.PREPAID_DB.prepare(
      `INSERT INTO analytics_events (ts, tool_name, payment_type, payer, revenue_usdc, latency_ms, detail, client)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        Date.now(),
        event.toolName,
        event.paymentType,
        event.payer,
        event.revenueUsdc,
        event.latencyMs,
        detail,
        event.client ?? null
      )
      .run()
      .catch(() => {
        // Silently swallow — analytics must never break tool calls
      })
  );
}

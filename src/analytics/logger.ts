/**
 * Analytics event writer — persists to D1 (analytics_events table).
 *
 * Writes are fire-and-forget (wrapped in try/catch) so they never fail
 * the main request. The table is created by migration 0002_analytics.sql.
 */

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
  | "tool_error";

export interface AnalyticsEvent {
  toolName: string;
  paymentType: PaymentType;
  payer: string;
  revenueUsdc: number;
  latencyMs: number;
}

export interface AnalyticsEnv {
  PREPAID_DB: D1Database;
}

export function writeEvent(env: AnalyticsEnv, event: AnalyticsEvent): void {
  // Fire-and-forget: never await, never throw
  env.PREPAID_DB.prepare(
    `INSERT INTO analytics_events (ts, tool_name, payment_type, payer, revenue_usdc, latency_ms)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      Date.now(),
      event.toolName,
      event.paymentType,
      event.payer,
      event.revenueUsdc,
      event.latencyMs
    )
    .run()
    .catch(() => {
      // Silently swallow — analytics must never break tool calls
    });
}

/**
 * D1 queries for the analytics dashboard (/analytics/data endpoint).
 * All queries run against the analytics_events table (migration 0002).
 */

const MS_30D = 30 * 24 * 60 * 60 * 1000;
const MS_365D = 365 * 24 * 60 * 60 * 1000;

/** payment_type values that represent a failure — used for error-rate and recent-errors queries. */
const ERROR_TYPES = [
  "402_rejected",
  "prepaid_insufficient",
  "prepaid_rejected",
  "deposit_failed",
  "settle_failed",
  "tool_error",
] as const;
const ERROR_TYPES_SQL = ERROR_TYPES.map((t) => `'${t}'`).join(", ");

export interface DashboardData {
  summary: {
    calls_30d: number;
    revenue_30d: number;
    unique_payers_30d: number;
    avg_latency_ms: number;
    p50_latency_ms: number;
    p95_latency_ms: number;
  };
  calls_by_day: Array<{ day: string; calls: number }>;
  revenue_by_day: Array<{ day: string; revenue: number }>;
  top_tools: Array<{ tool: string; calls: number }>;
  payment_breakdown: Array<{ type: string; calls: number }>;
  deposits: { count: number; total_usdc: number };
  recent_errors: Array<{
    ts: number;
    tool: string;
    type: string;
    payer: string;
    client: string | null;
    detail: string | null;
  }>;
  error_rate_by_tool: Array<{ tool: string; total: number; errors: number; error_pct: number }>;
}

/** Percentile via OFFSET on a sorted single-column result (SQLite has no PERCENTILE_CONT). */
async function latencyPercentile(
  db: D1Database,
  since: number,
  fraction: number,
  internalFilter: string
): Promise<number> {
  const count = await db
    .prepare(`SELECT count(*) AS n FROM analytics_events WHERE ts >= ? AND latency_ms > 0${internalFilter}`)
    .bind(since)
    .first<{ n: number }>();
  const n = count?.n ?? 0;
  if (n === 0) return 0;
  const offset = Math.min(n - 1, Math.floor(n * fraction));
  const row = await db
    .prepare(
      `SELECT latency_ms FROM analytics_events
       WHERE ts >= ? AND latency_ms > 0${internalFilter}
       ORDER BY latency_ms ASC
       LIMIT 1 OFFSET ?`
    )
    .bind(since, offset)
    .first<{ latency_ms: number }>();
  return row?.latency_ms ?? 0;
}

function dayLabel(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export async function getDashboardData(
  db: D1Database,
  includeInternal = false
): Promise<DashboardData> {
  const now = Date.now();
  const since30 = now - MS_30D;
  const since365 = now - MS_365D;
  // Own dev/testing traffic (internal = 1) is excluded by default — the panel
  // measures real external demand. Constant string, never user input.
  const internalFilter = includeInternal ? "" : " AND internal = 0";

  const [
    summary,
    topTools,
    payBreakdown,
    deposits,
    callsSeries,
    revSeries,
    recentErrors,
    errorRateByTool,
    p50,
    p95,
  ] = await Promise.all([
      db
        .prepare(
          `SELECT count(*) AS calls,
                  COALESCE(sum(revenue_usdc), 0) AS revenue,
                  count(DISTINCT CASE WHEN payer != 'anon' THEN payer END) AS payers,
                  COALESCE(avg(latency_ms), 0) AS avg_latency
           FROM analytics_events
           WHERE ts >= ?${internalFilter}`
        )
        .bind(since30)
        .first<{
          calls: number;
          revenue: number;
          payers: number;
          avg_latency: number;
        }>(),

      db
        .prepare(
          `SELECT tool_name AS tool, count(*) AS calls
           FROM analytics_events
           WHERE ts >= ?${internalFilter}
           GROUP BY tool_name
           ORDER BY calls DESC
           LIMIT 10`
        )
        .bind(since30)
        .all<{ tool: string; calls: number }>(),

      // 402_rejected is split into a benign "no wallet yet" handshake
      // (detail = no_payment_payload) vs. a real payment-verification failure,
      // so the panel doesn't conflate normal x402 discovery with lost revenue.
      db
        .prepare(
          `SELECT
             CASE
               WHEN payment_type = '402_rejected' AND (detail IS NULL OR detail = 'no_payment_payload')
                 THEN '402_no_wallet'
               WHEN payment_type = '402_rejected'
                 THEN '402_pay_failed'
               ELSE payment_type
             END AS type,
             count(*) AS calls
           FROM analytics_events
           WHERE ts >= ?${internalFilter}
           GROUP BY type
           ORDER BY calls DESC`
        )
        .bind(since30)
        .all<{ type: string; calls: number }>(),

      db
        .prepare(
          `SELECT count(*) AS cnt,
                  COALESCE(sum(revenue_usdc), 0) AS total
           FROM analytics_events
           WHERE tool_name = 'account_deposit'
             AND payment_type = 'deposit_success'
             AND ts >= ?${internalFilter}`
        )
        .bind(since30)
        .first<{ cnt: number; total: number }>(),

      // Calls per day — aggregate in JS from raw ts+count bucketed rows.
      // Up to 365 days of daily granularity; the panel re-buckets client-side
      // for wider timeframes so the timeframe selector never re-fetches.
      db
        .prepare(
          `SELECT ts, count(*) AS calls
           FROM analytics_events
           WHERE ts >= ?${internalFilter}
           GROUP BY (ts / 86400000)
           ORDER BY ts ASC`
        )
        .bind(since365)
        .all<{ ts: number; calls: number }>(),

      db
        .prepare(
          `SELECT ts, COALESCE(sum(revenue_usdc), 0) AS revenue
           FROM analytics_events
           WHERE ts >= ?${internalFilter}
           GROUP BY (ts / 86400000)
           ORDER BY ts ASC`
        )
        .bind(since365)
        .all<{ ts: number; revenue: number }>(),

      db
        .prepare(
          `SELECT ts, tool_name AS tool, payment_type AS type, payer, client, detail
           FROM analytics_events
           WHERE ts >= ? AND payment_type IN (${ERROR_TYPES_SQL})${internalFilter}
           ORDER BY ts DESC
           LIMIT 15`
        )
        .bind(since30)
        .all<{
          ts: number;
          tool: string;
          type: string;
          payer: string;
          client: string | null;
          detail: string | null;
        }>(),

      db
        .prepare(
          `SELECT tool_name AS tool,
                  count(*) AS total,
                  sum(CASE WHEN payment_type IN (${ERROR_TYPES_SQL}) THEN 1 ELSE 0 END) AS errors
           FROM analytics_events
           WHERE ts >= ?${internalFilter}
           GROUP BY tool_name
           HAVING errors > 0
           ORDER BY errors DESC
           LIMIT 10`
        )
        .bind(since30)
        .all<{ tool: string; total: number; errors: number }>(),

      latencyPercentile(db, since30, 0.5, internalFilter),
      latencyPercentile(db, since30, 0.95, internalFilter),
    ]);

  const s = summary ?? { calls: 0, revenue: 0, payers: 0, avg_latency: 0 };
  const dep = deposits ?? { cnt: 0, total: 0 };

  return {
    summary: {
      calls_30d: s.calls,
      revenue_30d: s.revenue,
      unique_payers_30d: s.payers,
      avg_latency_ms: Math.round(s.avg_latency),
      p50_latency_ms: p50,
      p95_latency_ms: p95,
    },
    calls_by_day: (callsSeries.results ?? []).map((r) => ({
      day: dayLabel(r.ts),
      calls: r.calls,
    })),
    revenue_by_day: (revSeries.results ?? []).map((r) => ({
      day: dayLabel(r.ts),
      revenue: r.revenue,
    })),
    top_tools: topTools.results ?? [],
    payment_breakdown: payBreakdown.results ?? [],
    deposits: { count: dep.cnt, total_usdc: dep.total },
    recent_errors: recentErrors.results ?? [],
    error_rate_by_tool: (errorRateByTool.results ?? []).map((r) => ({
      tool: r.tool,
      total: r.total,
      errors: r.errors,
      error_pct: r.total > 0 ? Math.round((r.errors / r.total) * 100) : 0,
    })),
  };
}

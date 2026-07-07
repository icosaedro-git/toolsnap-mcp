/**
 * D1 queries for the analytics dashboard (/analytics/data endpoint).
 * All queries run against the analytics_events table (migration 0002).
 */

import { FAMILIES } from "../tools/catalog.js";

const MS_30D = 30 * 24 * 60 * 60 * 1000;
const MS_365D = 365 * 24 * 60 * 60 * 1000;

/** tool_name -> family ids, precomputed once from the catalog (a tool can belong to >1 family). */
const TOOL_FAMILIES: Record<string, string[]> = (() => {
  const map: Record<string, string[]> = {};
  for (const [familyId, family] of Object.entries(FAMILIES)) {
    for (const tool of family.tools) {
      (map[tool] ??= []).push(familyId);
    }
  }
  return map;
})();

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
  /** Fase 24 — which MCP client/surface is connecting, calling, paying. */
  surface: {
    connects_by_client: Array<{ client: string; connects: number }>;
    calls_by_client: Array<{ client: string; calls: number }>;
    revenue_by_client: Array<{ client: string; revenue: number }>;
    /**
     * Per-surface funnel: connect -> >=1 tool call -> >=3 calls in the same
     * family (CP-tarea-completa, nota 07) -> paid call. Computed from raw
     * per-session rows (session_id present) rather than in SQL — session
     * counts are small at this stage; revisit if volume grows.
     */
    funnel_by_client: Array<{
      client: string;
      sessions: number;
      sessions_with_call: number;
      sessions_family_complete: number;
      sessions_paid: number;
    }>;
  };
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
    connectsByClient,
    callsByClient,
    revenueByClient,
    sessionRows,
  ] = await Promise.all([
      db
        .prepare(
          `SELECT count(*) AS calls,
                  COALESCE(sum(revenue_usdc), 0) AS revenue,
                  count(DISTINCT CASE WHEN payer != 'anon' THEN payer END) AS payers,
                  COALESCE(avg(latency_ms), 0) AS avg_latency
           FROM analytics_events
           WHERE ts >= ? AND payment_type != 'connect'${internalFilter}`
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
           WHERE ts >= ? AND payment_type != 'connect'${internalFilter}
           GROUP BY tool_name
           ORDER BY calls DESC
           LIMIT 10`
        )
        .bind(since30)
        .all<{ tool: string; calls: number }>(),

      // 402_rejected is split into a benign "no wallet yet" handshake
      // (detail = no_payment_payload) vs. a real payment-verification failure,
      // so the panel doesn't conflate normal x402 discovery with lost revenue.
      // "connect" (Fase 24, one per MCP initialize) is a connection event, not
      // a tool-call payment outcome — excluded from this chart too.
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
           WHERE ts >= ? AND payment_type != 'connect'${internalFilter}
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
           WHERE ts >= ? AND payment_type != 'connect'${internalFilter}
           GROUP BY (ts / 86400000)
           ORDER BY ts ASC`
        )
        .bind(since365)
        .all<{ ts: number; calls: number }>(),

      db
        .prepare(
          `SELECT ts, COALESCE(sum(revenue_usdc), 0) AS revenue
           FROM analytics_events
           WHERE ts >= ? AND payment_type != 'connect'${internalFilter}
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

      // NOTE: GROUP BY the raw COALESCE(...) expression, not its output alias
      // ("client") — grouping by the alias mis-collapses rows in D1's SQLite
      // (verified: all rows landed in one bucket keyed by the first row's
      // value). Grouping by the full expression is correct and reproducible.
      db
        .prepare(
          `SELECT COALESCE(client_name, 'unknown') AS client, count(*) AS connects
           FROM analytics_events
           WHERE ts >= ? AND payment_type = 'connect'${internalFilter}
           GROUP BY COALESCE(client_name, 'unknown')
           ORDER BY connects DESC`
        )
        .bind(since30)
        .all<{ client: string; connects: number }>(),

      db
        .prepare(
          `SELECT COALESCE(client_name, 'unknown') AS client, count(*) AS calls
           FROM analytics_events
           WHERE ts >= ? AND payment_type != 'connect'${internalFilter}
           GROUP BY COALESCE(client_name, 'unknown')
           ORDER BY calls DESC`
        )
        .bind(since30)
        .all<{ client: string; calls: number }>(),

      db
        .prepare(
          `SELECT COALESCE(client_name, 'unknown') AS client, COALESCE(sum(revenue_usdc), 0) AS revenue
           FROM analytics_events
           WHERE ts >= ?${internalFilter}
           GROUP BY COALESCE(client_name, 'unknown')
           ORDER BY revenue DESC`
        )
        .bind(since30)
        .all<{ client: string; revenue: number }>(),

      // Raw per-session rows for the funnel below — session counts are small
      // at this stage of the product, so this is computed in JS rather than
      // a heavier SQL query. Cap protects against an unexpected volume spike.
      db
        .prepare(
          `SELECT session_id, COALESCE(client_name, 'unknown') AS client, tool_name AS tool,
                  payment_type AS type, revenue_usdc AS revenue
           FROM analytics_events
           WHERE ts >= ? AND session_id IS NOT NULL AND payment_type != 'connect'${internalFilter}
           LIMIT 20000`
        )
        .bind(since30)
        .all<{ session_id: string; client: string; tool: string; type: string; revenue: number }>(),
    ]);

  const s = summary ?? { calls: 0, revenue: 0, payers: 0, avg_latency: 0 };
  const dep = deposits ?? { cnt: 0, total: 0 };

  // Fase 24 — per-session funnel: connect -> >=1 call -> >=3 calls in one
  // family -> paid. Grouped by session_id first (a session belongs to one
  // client), then rolled up per client.
  interface SessionAgg {
    client: string;
    familyCounts: Record<string, number>;
    paid: boolean;
  }
  const sessions = new Map<string, SessionAgg>();
  for (const row of sessionRows.results ?? []) {
    let agg = sessions.get(row.session_id);
    if (!agg) {
      agg = { client: row.client, familyCounts: {}, paid: false };
      sessions.set(row.session_id, agg);
    }
    for (const familyId of TOOL_FAMILIES[row.tool] ?? []) {
      agg.familyCounts[familyId] = (agg.familyCounts[familyId] ?? 0) + 1;
    }
    if (row.revenue > 0) agg.paid = true;
  }
  const funnelByClient = new Map<
    string,
    { sessions: number; sessions_with_call: number; sessions_family_complete: number; sessions_paid: number }
  >();
  for (const agg of sessions.values()) {
    const bucket = funnelByClient.get(agg.client) ?? {
      sessions: 0,
      sessions_with_call: 0,
      sessions_family_complete: 0,
      sessions_paid: 0,
    };
    bucket.sessions += 1;
    const totalCalls = Object.values(agg.familyCounts).reduce((a, b) => a + b, 0);
    if (totalCalls >= 1) bucket.sessions_with_call += 1;
    if (Object.values(agg.familyCounts).some((n) => n >= 3)) bucket.sessions_family_complete += 1;
    if (agg.paid) bucket.sessions_paid += 1;
    funnelByClient.set(agg.client, bucket);
  }

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
    surface: {
      connects_by_client: connectsByClient.results ?? [],
      calls_by_client: callsByClient.results ?? [],
      revenue_by_client: revenueByClient.results ?? [],
      funnel_by_client: Array.from(funnelByClient.entries()).map(([client, f]) => ({ client, ...f })),
    },
  };
}

const MS_7D = 7 * 24 * 60 * 60 * 1000;

export interface WeeklySurfaceDigest {
  connects_this_week: Array<{ client: string; connects: number }>;
  connects_last_week: Array<{ client: string; connects: number }>;
  calls_this_week: Array<{ client: string; calls: number }>;
  total_calls_this_week: number;
  total_calls_last_week: number;
  total_revenue_this_week: number;
  top_tools_this_week: Array<{ tool: string; calls: number }>;
  /** free-tier tool calls that converted into a paid call, this week (x402/prepaid/api_key, excluding rejections). */
  paid_calls_this_week: number;
}

/**
 * Data for the Telegram weekly digest (Fase 24.3) — this week vs last week,
 * by surface (client_name). Excludes internal traffic unconditionally (the
 * digest reports on real external demand, same default as the panel).
 */
export async function getWeeklySurfaceDigest(db: D1Database, now = Date.now()): Promise<WeeklySurfaceDigest> {
  const startThisWeek = now - MS_7D;
  const startLastWeek = now - 2 * MS_7D;

  const PAID_TYPES = ["x402_paid", "x402_free_first", "prepaid", "api_key"];
  const paidPlaceholders = PAID_TYPES.map(() => "?").join(",");

  const [connectsThis, connectsLast, callsThis, revThis, topTools, paidThis] = await Promise.all([
    db
      .prepare(
        `SELECT COALESCE(client_name, 'unknown') AS client, count(*) AS connects
         FROM analytics_events
         WHERE ts >= ? AND payment_type = 'connect' AND internal = 0
         GROUP BY COALESCE(client_name, 'unknown')
         ORDER BY connects DESC`
      )
      .bind(startThisWeek)
      .all<{ client: string; connects: number }>(),

    db
      .prepare(
        `SELECT COALESCE(client_name, 'unknown') AS client, count(*) AS connects
         FROM analytics_events
         WHERE ts >= ? AND ts < ? AND payment_type = 'connect' AND internal = 0
         GROUP BY COALESCE(client_name, 'unknown')
         ORDER BY connects DESC`
      )
      .bind(startLastWeek, startThisWeek)
      .all<{ client: string; connects: number }>(),

    db
      .prepare(
        `SELECT COALESCE(client_name, 'unknown') AS client, count(*) AS calls
         FROM analytics_events
         WHERE ts >= ? AND payment_type != 'connect' AND internal = 0
         GROUP BY COALESCE(client_name, 'unknown')
         ORDER BY calls DESC`
      )
      .bind(startThisWeek)
      .all<{ client: string; calls: number }>(),

    db
      .prepare(
        `SELECT count(*) AS calls_this, COALESCE(sum(revenue_usdc), 0) AS revenue
         FROM analytics_events
         WHERE ts >= ? AND payment_type != 'connect' AND internal = 0`
      )
      .bind(startThisWeek)
      .first<{ calls_this: number; revenue: number }>(),

    db
      .prepare(
        `SELECT tool_name AS tool, count(*) AS calls
         FROM analytics_events
         WHERE ts >= ? AND payment_type != 'connect' AND internal = 0
         GROUP BY tool_name
         ORDER BY calls DESC
         LIMIT 5`
      )
      .bind(startThisWeek)
      .all<{ tool: string; calls: number }>(),

    db
      .prepare(
        `SELECT count(*) AS n FROM analytics_events
         WHERE ts >= ? AND internal = 0 AND payment_type IN (${paidPlaceholders})`
      )
      .bind(startThisWeek, ...PAID_TYPES)
      .first<{ n: number }>(),
  ]);

  const lastWeekTotal = await db
    .prepare(
      `SELECT count(*) AS n FROM analytics_events
       WHERE ts >= ? AND ts < ? AND payment_type != 'connect' AND internal = 0`
    )
    .bind(startLastWeek, startThisWeek)
    .first<{ n: number }>();

  return {
    connects_this_week: connectsThis.results ?? [],
    connects_last_week: connectsLast.results ?? [],
    calls_this_week: callsThis.results ?? [],
    total_calls_this_week: revThis?.calls_this ?? 0,
    total_calls_last_week: lastWeekTotal?.n ?? 0,
    total_revenue_this_week: revThis?.revenue ?? 0,
    top_tools_this_week: topTools.results ?? [],
    paid_calls_this_week: paidThis?.n ?? 0,
  };
}

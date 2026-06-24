/**
 * D1 queries for the analytics dashboard (/analytics/data endpoint).
 * All queries run against the analytics_events table (migration 0002).
 */

const MS_30D = 30 * 24 * 60 * 60 * 1000;
const MS_7D = 7 * 24 * 60 * 60 * 1000;

export interface DashboardData {
  summary: {
    calls_30d: number;
    revenue_30d: number;
    unique_payers_30d: number;
    avg_latency_ms: number;
  };
  calls_by_day: Array<{ day: string; calls: number }>;
  revenue_by_day: Array<{ day: string; revenue: number }>;
  top_tools: Array<{ tool: string; calls: number }>;
  payment_breakdown: Array<{ type: string; calls: number }>;
  deposits: { count: number; total_usdc: number };
}

function dayLabel(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export async function getDashboardData(db: D1Database): Promise<DashboardData> {
  const now = Date.now();
  const since30 = now - MS_30D;
  const since7 = now - MS_7D;

  const [summary, topTools, payBreakdown, deposits, callsSeries, revSeries] =
    await Promise.all([
      db
        .prepare(
          `SELECT count(*) AS calls,
                  COALESCE(sum(revenue_usdc), 0) AS revenue,
                  count(DISTINCT CASE WHEN payer != 'anon' THEN payer END) AS payers,
                  COALESCE(avg(latency_ms), 0) AS avg_latency
           FROM analytics_events
           WHERE ts >= ?`
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
           WHERE ts >= ?
           GROUP BY tool_name
           ORDER BY calls DESC
           LIMIT 10`
        )
        .bind(since30)
        .all<{ tool: string; calls: number }>(),

      db
        .prepare(
          `SELECT payment_type AS type, count(*) AS calls
           FROM analytics_events
           WHERE ts >= ?
           GROUP BY payment_type
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
             AND ts >= ?`
        )
        .bind(since30)
        .first<{ cnt: number; total: number }>(),

      // Calls per day — aggregate in JS from raw ts+count bucketed rows
      db
        .prepare(
          `SELECT ts, count(*) AS calls
           FROM analytics_events
           WHERE ts >= ?
           GROUP BY (ts / 86400000)
           ORDER BY ts ASC`
        )
        .bind(since7)
        .all<{ ts: number; calls: number }>(),

      db
        .prepare(
          `SELECT ts, COALESCE(sum(revenue_usdc), 0) AS revenue
           FROM analytics_events
           WHERE ts >= ?
           GROUP BY (ts / 86400000)
           ORDER BY ts ASC`
        )
        .bind(since7)
        .all<{ ts: number; revenue: number }>(),
    ]);

  const s = summary ?? { calls: 0, revenue: 0, payers: 0, avg_latency: 0 };
  const dep = deposits ?? { cnt: 0, total: 0 };

  return {
    summary: {
      calls_30d: s.calls,
      revenue_30d: s.revenue,
      unique_payers_30d: s.payers,
      avg_latency_ms: Math.round(s.avg_latency),
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
  };
}

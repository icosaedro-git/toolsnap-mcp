/**
 * D1 queries for the analytics dashboard (/analytics/data endpoint).
 * All queries run against the analytics_events table (migration 0002).
 */

import { FAMILIES } from "../tools/catalog.js";
import { PROBE_CLIENTS } from "./surface.js";
import { isUpstreamError } from "../alerts/error-classification.js";

const MS_7D = 7 * 24 * 60 * 60 * 1000;
const MS_30D = 30 * 24 * 60 * 60 * 1000;
const MS_365D = 365 * 24 * 60 * 60 * 1000;

/** MCP directory/registry scrapers (see surface.ts PROBE_CLIENTS) — a fixed constant list, never user input. */
const PROBE_CLIENTS_SQL = Array.from(PROBE_CLIENTS)
  .map((c) => `'${c}'`)
  .join(", ");

/**
 * SQL fragment excluding directory-probe traffic from demand metrics —
 * shared by the panel's internalFilter and the weekly digest so the two
 * report on the same notion of "real demand".
 */
const NON_PROBE_SQL = ` AND (client_name IS NULL OR client_name NOT IN (${PROBE_CLIENTS_SQL}))`;

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

/**
 * payment_type values that represent a failure — used for error-rate and
 * recent-errors queries. Fase 24.7 — added fiat_deposit_failed (the exact
 * failure mode of the 9-day-uncredited-webhook incident, previously
 * invisible in this table) and the api_key/oauth rejection/insufficient
 * types, for the same reason prepaid_* were already here.
 */
const ERROR_TYPES = [
  "402_rejected",
  "prepaid_insufficient",
  "prepaid_rejected",
  "deposit_failed",
  "fiat_deposit_failed",
  "api_key_rejected",
  "api_key_insufficient",
  "oauth_insufficient",
  "settle_failed",
  "tool_error",
] as const;
const ERROR_TYPES_SQL = ERROR_TYPES.map((t) => `'${t}'`).join(", ");

/** Fase 24.7 — payment_types that represent cash entering the system (deposits/purchases), not usage revenue. */
const DEPOSIT_TYPES_SQL = `'deposit_success', 'fiat_deposit_success'`;

export interface DashboardData {
  summary: {
    calls_30d: number;
    /** Fase 24.7 — usage revenue only (x402/prepaid/api_key/oauth debits). Excludes deposit/purchase cash-in — see `credits`. */
    revenue_30d: number;
    unique_payers_30d: number;
    /**
     * Fase 24.6 — distinct anonymous agents (payer LIKE 'anon:%', the
     * salted IP-hash pseudonyms). Disjoint from unique_payers_30d, which
     * counts identified payers (wallets/accounts) only — before the hash,
     * all anonymous traffic collapsed into one literal "anon" and this
     * number was invisible.
     */
    unique_anon_agents_30d: number;
    /** Fase 24.7 — distinct payers (payer != 'anon', includes anon:% hashes) seen both this week and the previous — a retention signal. */
    returning_agents_7d: number;
    avg_latency_ms: number;
    p50_latency_ms: number;
    p95_latency_ms: number;
  };
  calls_by_day: Array<{ day: string; calls: number }>;
  revenue_by_day: Array<{ day: string; revenue: number }>;
  /** Fase 24.7 — 30-minute buckets, last 7 days, for the intraday chart views (excludes connect + deposits, same as calls_by_day/revenue_by_day). */
  calls_by_halfhour: Array<{ ts: number; calls: number }>;
  revenue_by_halfhour: Array<{ ts: number; revenue: number }>;
  top_tools: Array<{ tool: string; calls: number }>;
  payment_breakdown: Array<{ type: string; calls: number }>;
  /**
   * Fase 24.7 — cash entering the system via either rail (crypto x402 deposit
   * or fiat Polar purchase), replacing the crypto-only `deposits` field.
   * `outstanding_usdc`/`lifetime_purchased_usdc`/`lifetime_consumed_usdc`/
   * `accounts` come straight from the `balances` table (source of truth for
   * money, see migrations/0001_prepaid.sql) — not derived from events.
   */
  credits: {
    purchased_30d: { crypto: { count: number; total_usdc: number }; fiat: { count: number; total_usdc: number } };
    outstanding_usdc: number;
    lifetime_purchased_usdc: number;
    lifetime_consumed_usdc: number;
    accounts: number;
  };
  /** Fase 24.7 — log of individual credit purchases (both rails), last 365d, newest first. */
  credit_purchases: Array<{ ts: number; type: string; payer: string; amount: number; detail: string | null }>;
  recent_errors: Array<{
    ts: number;
    tool: string;
    type: string;
    payer: string;
    client: string | null;
    detail: string | null;
  }>;
  /**
   * Fase 24.6 — errors split into upstream (destination site 4xx/5xx, SPA,
   * our own rate limit — not a ToolSnap malfunction) vs ours, using the same
   * classification error-alerts.ts uses to decide what pages Telegram (see
   * error-classification.ts). `errors` stays the combined total for
   * backwards compat with existing consumers of this field.
   */
  error_rate_by_tool: Array<{
    tool: string;
    total: number;
    errors: number;
    our_errors: number;
    upstream_errors: number;
    error_pct: number;
  }>;
  /** Fase 24.6 — p50/p95 latency per tool (top 10 by call volume), catches a slow provider hidden by the global average. */
  latency_by_tool: Array<{ tool: string; calls: number; p50_latency_ms: number; p95_latency_ms: number }>;
  /**
   * Fase 24.6 — MCP directory/registry scrapers that connect and read the
   * catalog but aren't real agent demand (see surface.ts PROBE_CLIENTS).
   * Excluded from every other metric above; reported here on its own as a
   * listing-health signal, not discarded as noise.
   */
  directory_coverage: Array<{ client: string; hits: number; last_seen: number }>;
  /**
   * Fase 24.6 — how many distinct payers hit the x402 paywall (402_rejected)
   * and, within 7 days after their first hit, converted (called
   * wallet_setup, or a payment_type of x402_paid/x402_free_first/prepaid/
   * api_key/oauth). Direct signal for whether the actionable 402
   * error.message (Fase 24.5) recovers lost conversion.
   */
  paywall_funnel: { hit_payers: number; converted_payers: number };
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

/** Percentile of an in-memory array — used for the per-tool latency breakdown (bounded row fetch, see below). */
function percentileOf(sortedAsc: number[], fraction: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * fraction));
  return sortedAsc[idx];
}

const PAID_CONVERSION_TYPES = ["x402_paid", "x402_free_first", "prepaid", "api_key", "oauth"];

/**
 * Fase 24.6 — how many distinct payers hit the x402 paywall (402_rejected)
 * in the window, and how many of them converted (called wallet_setup, or
 * made a paid-type call) within 7 days of a hit. Correlation needs TWO keys
 * because the payer label CHANGES on conversion: the 402 hit logs the
 * anon-hash pseudonym, but the successful x402 retry logs the wallet
 * address (and an API-key/OAuth payment logs acct:...). So a conversion
 * matches on either (a) same payer — covers wallet_setup and repeat anon
 * activity — or (b) same session_id — covers the classic 402 → sign →
 * retry flow, which happens within one MCP session (server-assigned since
 * Fase 24.5).
 */
async function paywallConversionFunnel(
  db: D1Database,
  since: number,
  internalFilter: string
): Promise<{ hit_payers: number; converted_payers: number }> {
  const paidPlaceholders = PAID_CONVERSION_TYPES.map(() => "?").join(", ");
  const row = await db
    .prepare(
      `WITH hits AS (
         SELECT payer, session_id, ts
         FROM analytics_events
         WHERE ts >= ? AND payment_type = '402_rejected'${internalFilter}
       ),
       converted AS (
         SELECT DISTINCT h.payer
         FROM hits h
         JOIN analytics_events e
           ON (e.payer = h.payer OR (h.session_id IS NOT NULL AND e.session_id = h.session_id))
          AND e.ts > h.ts
          AND e.ts <= h.ts + ${MS_7D}
          AND (e.tool_name = 'wallet_setup' OR e.payment_type IN (${paidPlaceholders}))
       )
       SELECT (SELECT count(DISTINCT payer) FROM hits) AS hit_payers,
              (SELECT count(*) FROM converted) AS converted_payers`
    )
    .bind(since, ...PAID_CONVERSION_TYPES)
    .first<{ hit_payers: number; converted_payers: number }>();
  return { hit_payers: row?.hit_payers ?? 0, converted_payers: row?.converted_payers ?? 0 };
}

export async function getDashboardData(
  db: D1Database,
  includeInternal = false
): Promise<DashboardData> {
  const now = Date.now();
  const since30 = now - MS_30D;
  const since365 = now - MS_365D;
  const since7 = now - MS_7D;
  // Own dev/testing traffic (internal = 1) is excluded by default — the panel
  // measures real external demand. Directory/registry probes (Fase 24.6) are
  // bundled into the same toggle: real signal is what ?include_internal=1
  // is for, and a probe scraping the catalog isn't demand either. Constant
  // string, never user input.
  const internalFilter = includeInternal
    ? ""
    : ` AND internal = 0${NON_PROBE_SQL}`;

  const [
    summary,
    topTools,
    payBreakdown,
    creditPurchasesSummary,
    creditPurchases,
    creditLiability,
    callsSeries,
    revSeries,
    callsHalfhour,
    revenueHalfhour,
    returningAgents,
    recentErrors,
    totalByTool,
    errorRows,
    latencyRows,
    p50,
    p95,
    connectsByClient,
    callsByClient,
    revenueByClient,
    sessionRows,
    directoryCoverage,
    paywallFunnel,
  ] = await Promise.all([
      db
        .prepare(
          `SELECT count(*) AS calls,
                  COALESCE(sum(CASE WHEN payment_type NOT IN (${DEPOSIT_TYPES_SQL}) THEN revenue_usdc ELSE 0 END), 0) AS revenue,
                  count(DISTINCT CASE WHEN payer NOT LIKE 'anon%' THEN payer END) AS payers,
                  count(DISTINCT CASE WHEN payer LIKE 'anon:%' THEN payer END) AS anon_agents,
                  COALESCE(avg(latency_ms), 0) AS avg_latency
           FROM analytics_events
           WHERE ts >= ? AND payment_type != 'connect'${internalFilter}`
        )
        .bind(since30)
        .first<{
          calls: number;
          revenue: number;
          payers: number;
          anon_agents: number;
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

      // Fase 24.7 — cash purchases split by rail. Replays (Polar webhook
      // redelivery, guarded by polar_orders PK — see index.ts) log
      // revenue_usdc = 0 with detail starting "replay", excluded here so a
      // retried delivery doesn't inflate the purchase count.
      db
        .prepare(
          `SELECT CASE WHEN payment_type = 'fiat_deposit_success' THEN 'fiat' ELSE 'crypto' END AS rail,
                  count(*) AS cnt,
                  COALESCE(sum(revenue_usdc), 0) AS total
           FROM analytics_events
           WHERE payment_type IN (${DEPOSIT_TYPES_SQL})
             AND ts >= ? AND (detail IS NULL OR detail NOT LIKE 'replay%')${internalFilter}
           GROUP BY rail`
        )
        .bind(since30)
        .all<{ rail: "crypto" | "fiat"; cnt: number; total: number }>(),

      // Fase 24.7 — individual purchase log, both rails, wider window (cash
      // events are rare and valuable — 30d would hide most of them).
      db
        .prepare(
          `SELECT ts, payment_type AS type, payer, revenue_usdc AS amount, detail
           FROM analytics_events
           WHERE payment_type IN (${DEPOSIT_TYPES_SQL}) AND ts >= ?${internalFilter}
           ORDER BY ts DESC
           LIMIT 100`
        )
        .bind(since365)
        .all<{ ts: number; type: string; payer: string; amount: number; detail: string | null }>(),

      // Fase 24.7 — credit liability straight from the source-of-truth
      // balances table (see migrations/0001_prepaid.sql), not derived from
      // events: outstanding = money already charged but not yet consumed.
      db
        .prepare(
          `SELECT COALESCE(sum(balance_micro), 0) / 1e6 AS outstanding,
                  COALESCE(sum(total_deposited_micro), 0) / 1e6 AS lifetime_purchased,
                  COALESCE(sum(total_spent_micro), 0) / 1e6 AS lifetime_consumed,
                  count(*) AS accounts
           FROM balances`
        )
        .first<{ outstanding: number; lifetime_purchased: number; lifetime_consumed: number; accounts: number }>(),

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

      // Fase 24.7 — usage revenue only; deposit/purchase cash-in is reported
      // separately via `credits` (see summary.revenue_30d comment above).
      db
        .prepare(
          `SELECT ts, COALESCE(sum(revenue_usdc), 0) AS revenue
           FROM analytics_events
           WHERE ts >= ? AND payment_type != 'connect' AND payment_type NOT IN (${DEPOSIT_TYPES_SQL})${internalFilter}
           GROUP BY (ts / 86400000)
           ORDER BY ts ASC`
        )
        .bind(since365)
        .all<{ ts: number; revenue: number }>(),

      // Fase 24.7 — 30-minute buckets over 7 days for the intraday chart
      // views (TradingView-style 30m/1h/4h); the panel re-buckets client-side
      // from this one fetch, same pattern as the daily series above.
      db
        .prepare(
          `SELECT (ts / 1800000) * 1800000 AS bucket, count(*) AS calls
           FROM analytics_events
           WHERE ts >= ? AND payment_type != 'connect'${internalFilter}
           GROUP BY (ts / 1800000)
           ORDER BY bucket ASC`
        )
        .bind(since7)
        .all<{ bucket: number; calls: number }>(),

      db
        .prepare(
          `SELECT (ts / 1800000) * 1800000 AS bucket, COALESCE(sum(revenue_usdc), 0) AS revenue
           FROM analytics_events
           WHERE ts >= ? AND payment_type != 'connect' AND payment_type NOT IN (${DEPOSIT_TYPES_SQL})${internalFilter}
           GROUP BY (ts / 1800000)
           ORDER BY bucket ASC`
        )
        .bind(since7)
        .all<{ bucket: number; revenue: number }>(),

      // Fase 24.7 — retention: distinct payers (excluding the legacy 'anon'
      // literal; anon:<hash> pseudonyms count) seen both this week and last.
      db
        .prepare(
          `SELECT count(*) AS n FROM (
             SELECT payer FROM analytics_events
             WHERE ts >= ? AND payment_type != 'connect' AND payer != 'anon'${internalFilter}
             INTERSECT
             SELECT payer FROM analytics_events
             WHERE ts >= ? AND ts < ? AND payment_type != 'connect' AND payer != 'anon'${internalFilter}
           )`
        )
        .bind(since7, now - 2 * MS_7D, since7)
        .first<{ n: number }>(),

      db
        .prepare(
          `SELECT ts, tool_name AS tool, payment_type AS type, payer, client, detail
           FROM analytics_events
           WHERE ts >= ? AND payment_type IN (${ERROR_TYPES_SQL})${internalFilter}
           ORDER BY ts DESC
           LIMIT 200`
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

      // total calls per tool (error-rate denominator) — kept as a separate
      // lightweight query so errorRows below only has to fetch error rows,
      // not a full table scan.
      db
        .prepare(
          `SELECT tool_name AS tool, count(*) AS total
           FROM analytics_events
           WHERE ts >= ?${internalFilter}
           GROUP BY tool_name`
        )
        .bind(since30)
        .all<{ tool: string; total: number }>(),

      // Fase 24.6 — raw error rows (tool + detail only) so isUpstreamError
      // (shared with error-alerts.ts) can classify each one in JS instead of
      // duplicating that regex/string logic as SQL LIKE patterns.
      db
        .prepare(
          `SELECT tool_name AS tool, detail
           FROM analytics_events
           WHERE ts >= ? AND payment_type IN (${ERROR_TYPES_SQL})${internalFilter}
           LIMIT 20000`
        )
        .bind(since30)
        .all<{ tool: string; detail: string | null }>(),

      // Fase 24.6 — raw per-call latency rows for the per-tool p50/p95
      // breakdown below (computed in JS, same bounded-fetch pattern as the
      // session funnel). The global p50/p95 (latencyPercentile calls below)
      // stays SQL-side since it doesn't need per-tool grouping.
      db
        .prepare(
          `SELECT tool_name AS tool, latency_ms
           FROM analytics_events
           WHERE ts >= ? AND payment_type != 'connect' AND latency_ms > 0${internalFilter}
           LIMIT 20000`
        )
        .bind(since30)
        .all<{ tool: string; latency_ms: number }>(),

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

      // Fase 24.6 — directory coverage: the inverse of internalFilter's probe
      // exclusion above. Which known MCP directories/scrapers hit us in the
      // last 7 days, and when last — a listing-health signal, reported on
      // its own rather than folded into (or discarded from) demand metrics.
      db
        .prepare(
          `SELECT COALESCE(client_name, 'unknown') AS client, count(*) AS hits, MAX(ts) AS last_seen
           FROM analytics_events
           WHERE ts >= ? AND internal = 0 AND client_name IN (${PROBE_CLIENTS_SQL})
           GROUP BY COALESCE(client_name, 'unknown')
           ORDER BY last_seen DESC`
        )
        .bind(since7)
        .all<{ client: string; hits: number; last_seen: number }>(),

      paywallConversionFunnel(db, since30, internalFilter),
    ]);

  const s = summary ?? { calls: 0, revenue: 0, payers: 0, anon_agents: 0, avg_latency: 0 };
  const liability = creditLiability ?? { outstanding: 0, lifetime_purchased: 0, lifetime_consumed: 0, accounts: 0 };

  // Fase 24.7 — purchases-by-rail rolls up as { crypto, fiat }, defaulting a
  // missing rail to zero (e.g. no fiat purchases in the window at all).
  const purchasedByRail = { crypto: { count: 0, total_usdc: 0 }, fiat: { count: 0, total_usdc: 0 } };
  for (const row of creditPurchasesSummary.results ?? []) {
    purchasedByRail[row.rail] = { count: row.cnt, total_usdc: row.total };
  }

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

  // Fase 24.6 — classify each raw error row via the shared isUpstreamError
  // (error-classification.ts) and roll up per tool, joined against the
  // separately-fetched total-calls-per-tool denominator.
  const totalByToolMap = new Map((totalByTool.results ?? []).map((r) => [r.tool, r.total]));
  const errorAgg = new Map<string, { errors: number; upstream: number }>();
  for (const row of errorRows.results ?? []) {
    const agg = errorAgg.get(row.tool) ?? { errors: 0, upstream: 0 };
    agg.errors += 1;
    if (isUpstreamError(row.detail)) agg.upstream += 1;
    errorAgg.set(row.tool, agg);
  }
  const errorRateByToolOut = Array.from(errorAgg.entries())
    .map(([tool, agg]) => {
      const total = totalByToolMap.get(tool) ?? agg.errors;
      return {
        tool,
        total,
        errors: agg.errors,
        our_errors: agg.errors - agg.upstream,
        upstream_errors: agg.upstream,
        error_pct: total > 0 ? Math.round((agg.errors / total) * 100) : 0,
      };
    })
    .sort((a, b) => b.errors - a.errors)
    .slice(0, 10);

  // Fase 24.6 — per-tool p50/p95 from the raw latency rows, top 10 by volume.
  const latencyByTool = new Map<string, number[]>();
  for (const row of latencyRows.results ?? []) {
    const arr = latencyByTool.get(row.tool);
    if (arr) arr.push(row.latency_ms);
    else latencyByTool.set(row.tool, [row.latency_ms]);
  }
  const latencyByToolOut = Array.from(latencyByTool.entries())
    .map(([tool, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return {
        tool,
        calls: sorted.length,
        p50_latency_ms: percentileOf(sorted, 0.5),
        p95_latency_ms: percentileOf(sorted, 0.95),
      };
    })
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 10);

  return {
    summary: {
      calls_30d: s.calls,
      revenue_30d: s.revenue,
      unique_payers_30d: s.payers,
      unique_anon_agents_30d: s.anon_agents,
      returning_agents_7d: returningAgents?.n ?? 0,
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
    calls_by_halfhour: (callsHalfhour.results ?? []).map((r) => ({ ts: r.bucket, calls: r.calls })),
    revenue_by_halfhour: (revenueHalfhour.results ?? []).map((r) => ({ ts: r.bucket, revenue: r.revenue })),
    top_tools: topTools.results ?? [],
    payment_breakdown: payBreakdown.results ?? [],
    credits: {
      purchased_30d: purchasedByRail,
      outstanding_usdc: liability.outstanding,
      lifetime_purchased_usdc: liability.lifetime_purchased,
      lifetime_consumed_usdc: liability.lifetime_consumed,
      accounts: liability.accounts,
    },
    credit_purchases: creditPurchases.results ?? [],
    recent_errors: recentErrors.results ?? [],
    error_rate_by_tool: errorRateByToolOut,
    latency_by_tool: latencyByToolOut,
    directory_coverage: directoryCoverage.results ?? [],
    paywall_funnel: paywallFunnel,
    surface: {
      connects_by_client: connectsByClient.results ?? [],
      calls_by_client: callsByClient.results ?? [],
      revenue_by_client: revenueByClient.results ?? [],
      funnel_by_client: Array.from(funnelByClient.entries()).map(([client, f]) => ({ client, ...f })),
    },
  };
}

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
  /** Fase 24.6 — paywall-hit-to-conversion signal, this week (see getDashboardData's paywall_funnel). */
  paywall_funnel_this_week: { hit_payers: number; converted_payers: number };
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

  // Same "real external demand" notion as the panel: no internal traffic,
  // no directory-probe scrapers (Fase 24.6) — otherwise the digest's
  // connects/calls tables stay dominated by glimind-probe & friends.
  const digestFilter = ` AND internal = 0${NON_PROBE_SQL}`;

  const [connectsThis, connectsLast, callsThis, revThis, topTools, paidThis] = await Promise.all([
    db
      .prepare(
        `SELECT COALESCE(client_name, 'unknown') AS client, count(*) AS connects
         FROM analytics_events
         WHERE ts >= ? AND payment_type = 'connect'${digestFilter}
         GROUP BY COALESCE(client_name, 'unknown')
         ORDER BY connects DESC`
      )
      .bind(startThisWeek)
      .all<{ client: string; connects: number }>(),

    db
      .prepare(
        `SELECT COALESCE(client_name, 'unknown') AS client, count(*) AS connects
         FROM analytics_events
         WHERE ts >= ? AND ts < ? AND payment_type = 'connect'${digestFilter}
         GROUP BY COALESCE(client_name, 'unknown')
         ORDER BY connects DESC`
      )
      .bind(startLastWeek, startThisWeek)
      .all<{ client: string; connects: number }>(),

    db
      .prepare(
        `SELECT COALESCE(client_name, 'unknown') AS client, count(*) AS calls
         FROM analytics_events
         WHERE ts >= ? AND payment_type != 'connect'${digestFilter}
         GROUP BY COALESCE(client_name, 'unknown')
         ORDER BY calls DESC`
      )
      .bind(startThisWeek)
      .all<{ client: string; calls: number }>(),

    db
      .prepare(
        `SELECT count(*) AS calls_this, COALESCE(sum(revenue_usdc), 0) AS revenue
         FROM analytics_events
         WHERE ts >= ? AND payment_type != 'connect'${digestFilter}`
      )
      .bind(startThisWeek)
      .first<{ calls_this: number; revenue: number }>(),

    db
      .prepare(
        `SELECT tool_name AS tool, count(*) AS calls
         FROM analytics_events
         WHERE ts >= ? AND payment_type != 'connect'${digestFilter}
         GROUP BY tool_name
         ORDER BY calls DESC
         LIMIT 5`
      )
      .bind(startThisWeek)
      .all<{ tool: string; calls: number }>(),

    db
      .prepare(
        `SELECT count(*) AS n FROM analytics_events
         WHERE ts >= ?${digestFilter} AND payment_type IN (${paidPlaceholders})`
      )
      .bind(startThisWeek, ...PAID_TYPES)
      .first<{ n: number }>(),
  ]);

  const [lastWeekTotal, paywallFunnelThisWeek] = await Promise.all([
    db
      .prepare(
        `SELECT count(*) AS n FROM analytics_events
         WHERE ts >= ? AND ts < ? AND payment_type != 'connect'${digestFilter}`
      )
      .bind(startLastWeek, startThisWeek)
      .first<{ n: number }>(),
    paywallConversionFunnel(db, startThisWeek, digestFilter),
  ]);

  return {
    connects_this_week: connectsThis.results ?? [],
    connects_last_week: connectsLast.results ?? [],
    calls_this_week: callsThis.results ?? [],
    total_calls_this_week: revThis?.calls_this ?? 0,
    total_calls_last_week: lastWeekTotal?.n ?? 0,
    total_revenue_this_week: revThis?.revenue ?? 0,
    top_tools_this_week: topTools.results ?? [],
    paid_calls_this_week: paidThis?.n ?? 0,
    paywall_funnel_this_week: paywallFunnelThisWeek,
  };
}

/**
 * POST /v1/tools/<name> — flat HTTP route that runs a FREE tool and returns
 * its result as JSON, outside MCP/JSON-RPC (ADR-003).
 *
 * This route never charges. It is guarded by a double lock, checked in this
 * order and only AFTER the bearer token passes (so a 401 leaks nothing):
 *   1. the name must be in REST_ALLOWED (explicit allow-list, below);
 *   2. requiresPayment(name) must be false (same source of truth MCP bills by).
 * Either failure is a plain 404, never a 402 or anything hinting the tool
 * exists but costs money.
 */
import { callTool } from "./tools/index.js";
import { requiresPayment } from "./x402/middleware.js";
import { writeEvent } from "./analytics/logger.js";
import { anonPayerId } from "./analytics/surface.js";
import type { Env } from "./index.js";

/**
 * Tools reachable over REST. Every entry must be free (a test enforces
 * REST_ALLOWED ∩ paid tools = ∅ and that each name exists in the registry).
 * Adding a name here is a deliberate act; a tool never becomes REST-callable
 * just by being free.
 */
export const REST_ALLOWED: ReadonlySet<string> = new Set([
  // Free flagship extractors: server-side extraction whose output can go
  // straight to disk without touching a model, the whole point of this route.
  "fetch_extract",
  "fetch_html",
  "html_to_markdown",
  "fetch_metadata",
  // Query tools over a caller-supplied file URL: return only the matching slice.
  "json_query",
  "csv_query",
  "html_table_extract",
  // Structured parsers for feeds/sitemaps/PDFs/links: deterministic, no COGS.
  "sitemap_parse",
  "rss_parse",
  "pdf_text_extract",
  "page_links",
]);

/**
 * Every REST_ALLOWED tool fetches a caller-supplied URL, so all of them go
 * through FREE_FETCH_RL. RATE_LIMITED_FETCH_TOOLS in src/mcp/server.ts is not
 * exported (and that file is off limits here); limiting the whole allow-list
 * is a superset of it, i.e. the safe direction. See HALLAZGOS.md.
 */

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Constant-time string equality: hash both sides, then XOR the digests. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export async function handleRestTool(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  // ---- Auth. Missing / non-Bearer / wrong token: 401, nothing else. ------
  const auth = request.headers.get("authorization") ?? "";
  const m = /^Bearer (.+)$/i.exec(auth);
  const token = m ? m[1].trim() : "";
  if (!env.REST_API_TOKEN || !token || !(await safeEqual(token, env.REST_API_TOKEN))) {
    return json({ error: "unauthorized" }, 401);
  }

  // ---- Double lock ---------------------------------------------------------
  const raw = new URL(request.url).pathname.slice("/v1/tools/".length);
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return json({ error: "not_found" }, 404);
  }
  if (!REST_ALLOWED.has(name) || requiresPayment(name)) {
    return json({ error: "not_found" }, 404);
  }

  // ---- Body: the parsed JSON object IS the tool's arguments. --------------
  let args: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json({ ok: false, error: "Body must be a JSON object." }, 400);
    }
    args = parsed as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "Body is not valid JSON." }, 400);
  }

  const internalHeader = request.headers.get("x-toolsnap-internal");
  const isInternal = Boolean(env.TOOLSNAP_INTERNAL_TOKEN && internalHeader === env.TOOLSNAP_INTERNAL_TOKEN);
  const clientUA = request.headers.get("user-agent") ?? "";
  const clientIp = request.headers.get("cf-connecting-ip") ?? "unknown";
  const payer = await anonPayerId(env.ANALYTICS_HASH_SALT, clientIp);
  const t0 = Date.now();

  const log = (detail?: string) =>
    writeEvent(
      env,
      {
        toolName: name,
        paymentType: "free_tool",
        payer,
        revenueUsdc: 0,
        latencyMs: Date.now() - t0,
        detail,
        client: clientUA,
        internal: isInternal,
      },
      ctx
    );

  // ---- Same limiter as the MCP free path (internal traffic exempt). -------
  if (!isInternal) {
    const { success } = await env.FREE_FETCH_RL.limit({ key: clientIp });
    if (!success) {
      log("rate_limited");
      return json({ ok: false, error: "Rate limit: max 120 fetch calls per minute per IP." }, 429);
    }
  }

  try {
    const result = await callTool(name, args, env);
    log();
    return json({ ok: true, tool: name, result }, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`rest_error: ${message}`);
    return json({ ok: false, error: message }, 400);
  }
}

import { handleMcpRequest } from "./mcp/server.js";
import { tools, listTools } from "./tools/index.js";
import { requiresPayment, getToolPrice, firstCallFreeEligible } from "./x402/middleware.js";
import { PRICING_DATA } from "./tools/pricing.js";
import { getDashboardData } from "./analytics/queries.js";
import { PANEL_HTML } from "./analytics/panel.js";
import { checkUsageAlerts } from "./alerts/usage-alerts.js";

export interface Env {
  // x402 payment config (vars in wrangler.jsonc)
  X402_NETWORK: string;
  X402_PRICE_USDC: string;
  X402_PREPAID_PRICE_USDC: string;
  X402_MIN_DEPOSIT_USDC: string;
  BASE_RPC_URL: string;

  // x402 secrets (set via: wrangler secret put <NAME>)
  X402_PAY_TO_ADDRESS: string;
  RELAYER_PRIVATE_KEY: string;

  // Admin bypass key (set via: wrangler secret put ADMIN_API_KEY)
  ADMIN_API_KEY?: string;

  // Comma-separated EVM addresses whitelisted for free tool access via wallet signature
  WHITELISTED_ADDRESSES?: string;

  // KV namespace for nonce replay-protection + first-call-free tracking
  X402_NONCES: KVNamespace;

  // D1 database for prepaid balances + money ledger (Fase 8)
  PREPAID_DB: D1Database;

  // R2 bucket for screenshot_url captures (Fase 11.2)
  SCREENSHOTS_BUCKET: R2Bucket;

  // Public base URL for the screenshots bucket (r2.dev or custom domain)
  R2_PUBLIC_URL: string;

  // Screenshot provider selector: "screenshotone" | "microlink" (default microlink)
  SCREENSHOT_PROVIDER?: string;

  // ScreenshotOne access key (set via: wrangler secret put SCREENSHOT_API_KEY).
  // Optional — without it screenshot_url falls back to the keyless microlink provider.
  SCREENSHOT_API_KEY?: string;

  // Telegram usage alerts (set via: wrangler secret put TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID).
  // Optional — the scheduled alert handler no-ops when either is missing.
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;

  // DataForSEO credentials for keyword_research (set via: wrangler secret put DATAFORSEO_LOGIN/PASSWORD).
  DATAFORSEO_LOGIN?: string;
  DATAFORSEO_PASSWORD?: string;

  // fal.ai API key for remove_background and future generative tools (set via: wrangler secret put FAL_API_KEY).
  FAL_API_KEY?: string;

  // Marks our own dev/testing traffic in analytics (Fase 19).
  // Clients send X-ToolSnap-Internal: <token>; set via: wrangler secret put TOOLSNAP_INTERNAL_TOKEN.
  TOOLSNAP_INTERNAL_TOKEN?: string;

  // Comma-separated EVM addresses of our own wallets — their paid calls are marked internal.
  INTERNAL_WALLETS?: string;

}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, X-Admin-Key, X-ToolSnap-Internal",
};

function withCors(response: Response): Response {
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

function jsonResponse(data: unknown, status = 200): Response {
  return withCors(
    new Response(JSON.stringify(data, null, 2), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Favicon
    if (method === "GET" && (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico")) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#6366f1"/><stop offset="100%" stop-color="#4338ca"/></linearGradient></defs><rect width="256" height="256" rx="73" fill="url(#g)"/><svg x="64" y="64" width="128" height="128" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg></svg>`;
      return new Response(svg, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } });
    }

    // MCP endpoint
    if (method === "POST" && url.pathname === "/mcp") {
      let body: string;
      try {
        body = await request.text();
      } catch {
        return jsonResponse({ error: "Failed to read request body." }, 400);
      }

      const adminKey = request.headers.get("x-admin-key");
      const isAdmin = Boolean(env.ADMIN_API_KEY && adminKey === env.ADMIN_API_KEY);
      const clientUA = request.headers.get("user-agent") ?? "";
      const sessionId = request.headers.get("mcp-session-id") ?? "";
      const internalHeader = request.headers.get("x-toolsnap-internal");
      const isInternal = Boolean(
        env.TOOLSNAP_INTERNAL_TOKEN && internalHeader === env.TOOLSNAP_INTERNAL_TOKEN
      );

      const { response, status } = await handleMcpRequest(body, env, isAdmin, ctx, clientUA, sessionId, isInternal);

      if (response === null) {
        // Notification — 202 empty body with CORS
        return new Response(null, { status: 202, headers: CORS_HEADERS });
      }

      return withCors(
        new Response(response, {
          status,
          headers: { "Content-Type": "application/json" },
        })
      );
    }

    // Root info
    if (method === "GET" && url.pathname === "/") {
      return jsonResponse({
        name: "toolsnap-mcp",
        description:
          "Deterministic microtools for AI agents — no accounts, no API keys. Free flagship fetch_extract (98.1% median token reduction vs raw HTML, pure parsing, no LLM in the loop) + fetch_html + a wide free utility catalog. Paid: screenshot_url, keyword_research, remove_background (real-COGS tools), pay per call via x402 USDC on Base.",
        mcp_endpoint: "/mcp",
        well_known: "/.well-known/mcp.json",
        pricing: "/.well-known/pricing.json",
        tools: tools.length,
        docs: "https://toolsnap.app/agents",
      });
    }

    // Well-known MCP server card
    // Always the COMPLETE catalog (scope "full") — registries/directories need
    // to see every tool, unlike the curated core served by tools/list.
    if (method === "GET" && url.pathname === "/.well-known/mcp.json") {
      return jsonResponse({
        name: "toolsnap-mcp",
        version: "0.1.0",
        description:
          `Deterministic, context-efficient microtools for AI agents — no accounts, no API keys. ${tools.length} tools total. Extraction is pure parsing (no LLM in the loop): exact quotes, stable output, zero added inference cost. Free flagships fetch_extract (median 98.1% token reduction, 53,820 → 2,001 tokens, 11 real pages) and fetch_html, plus a wide free utility catalog (CSV/JSON/PDF query, HTML→Markdown, RSS, sitemap, metadata, token count, and more). Paid: screenshot_url, keyword_research, remove_background — real per-call COGS tools, $0.02–$0.04 USDC on Base via x402 (no first-call-free). Or deposit once ($0.50 min) and debit off-chain at a discount, no per-call gas.`,
        transport: "streamable-http",
        endpoint: "/mcp",
        pricing_endpoint: "/.well-known/pricing.json",
        payment: {
          method: "x402 v2",
          network: "eip155:8453",
          asset: "USDC",
          note: "Price varies per tool — see the tools array below or /.well-known/pricing.json.",
          prepaid: {
            min_deposit_usdc: 0.5,
            non_refundable: true,
            deposit_tool: "account_deposit",
            balance_tool: "account_balance",
            spend_meta_key: "x402/prepaid-spend",
          },
        },
        tools: listTools("full").map(({ name, description }) => {
          const paid = requiresPayment(name);
          if (!paid) return { name, description, tier: "free" };
          const p = getToolPrice(name, env);
          return {
            name,
            description,
            tier: "paid",
            price_usdc: Number(p.payPerCallStr),
            prepaid_price_usdc: Number(p.prepaidStr),
            first_call_free: firstCallFreeEligible(name),
          };
        }),
        docs: "https://toolsnap.app/agents",
      });
    }

    // Pricing menu (machine-readable)
    if (method === "GET" && url.pathname === "/.well-known/pricing.json") {
      return jsonResponse(PRICING_DATA);
    }

    // Glama connector claim file
    if (method === "GET" && url.pathname === "/.well-known/glama.json") {
      return jsonResponse({
        $schema: "https://glama.ai/mcp/schemas/connector.json",
        name: "ToolSnap MCP",
        description:
          `Deterministic, context-efficient microtools for AI agents — no accounts, no API keys. ${tools.length} tools total. Flagship: fetch_extract converts raw HTML to clean text with a median 98.1% token reduction (53,820 → 2,001 tokens, 11 real pages) via pure parsing, no LLM in the loop — free, like fetch_html and most of the catalog. Paid: screenshot_url, keyword_research, remove_background — real per-call COGS, $0.02–$0.04 USDC on Base via x402. Prepaid: deposit once ($0.50 min), debit off-chain at a discount.`,
        categories: ["developer-tools", "web-scraping", "data-extraction", "paid"],
        transport: "streamable-http",
        homepage: "https://toolsnap.app/agents",
        endpoint: "https://mcp.toolsnap.app/mcp",
        pricing_endpoint: "https://mcp.toolsnap.app/.well-known/pricing.json",
        maintainers: [{ email: "icosaedro.one@proton.me" }],
      });
    }

    // Analytics dashboard (Fase 9)
    // Protected externally via Cloudflare Access (mcp.toolsnap.app/analytics*)
    // Setup: https://one.dash.cloudflare.com → Access → Applications → add app for /analytics*
    if (method === "GET" && url.pathname === "/analytics") {
      return new Response(PANEL_HTML, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Analytics data API — called by the dashboard panel via fetch('/analytics/data')
    // ?include_internal=1 also counts our own dev/testing traffic (excluded by default).
    if (method === "GET" && url.pathname === "/analytics/data") {
      try {
        const includeInternal = url.searchParams.get("include_internal") === "1";
        const data = await getDashboardData(env.PREPAID_DB, includeInternal);
        return jsonResponse(data);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResponse({ error: message }, 502);
      }
    }

    // File upload — POST /upload
    // Accepts raw image bytes (Content-Type: image/jpeg|png|webp|gif), stores in R2
    // under uploads/ as a temporary file. Consumed tools (e.g. remove_background)
    // delete the upload immediately after reading it.
    // Returns { url, key, content_type, file_size_bytes }. Free, no auth required.
    if (method === "POST" && url.pathname === "/upload") {
      const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      const ALLOWED: Record<string, string> = {
        "image/jpeg": "jpg", "image/jpg": "jpg",
        "image/png": "png", "image/webp": "webp", "image/gif": "gif",
      };
      const ext = ALLOWED[contentType];
      if (!ext) {
        return jsonResponse({ error: `Unsupported content-type "${contentType}". Allowed: image/jpeg, image/png, image/webp, image/gif` }, 415);
      }
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > 10 * 1024 * 1024) {
        return jsonResponse({ error: "File too large (max 10 MB)" }, 413);
      }
      const key = `uploads/${Date.now()}-${Math.random().toString(36).slice(2, 9)}.${ext}`;
      await env.SCREENSHOTS_BUCKET.put(key, bytes, { httpMetadata: { contentType } });
      const workerBase = new URL(request.url).origin;
      return jsonResponse({ url: `${workerBase}/files/${key}`, key, content_type: contentType, file_size_bytes: bytes.byteLength });
    }

    // File serving — GET /files/:key  (serves R2 objects uploaded via /upload or by tools)
    if (method === "GET" && url.pathname.startsWith("/files/")) {
      const key = url.pathname.slice("/files/".length);
      if (!key) return jsonResponse({ error: "Missing file key" }, 400);
      const obj = await env.SCREENSHOTS_BUCKET.get(key);
      if (!obj) return jsonResponse({ error: "File not found" }, 404);
      const ct = obj.httpMetadata?.contentType ?? "application/octet-stream";
      return new Response(obj.body, { status: 200, headers: { "Content-Type": ct, ...CORS_HEADERS } });
    }

    // 404
    return jsonResponse({ error: "Not found" }, 404);
  },

  // Cron Trigger (daily) — usage alerts for COGS tools (screenshot_url quota).
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      checkUsageAlerts(env).catch((err) =>
        console.error("usage-alerts cron failed:", err instanceof Error ? err.message : err)
      )
    );
  },
};

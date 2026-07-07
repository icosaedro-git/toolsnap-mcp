import { handleMcpRequest } from "./mcp/server.js";
import { tools, listTools } from "./tools/index.js";
import { requiresPayment, getToolPrice, firstCallFreeEligible } from "./x402/middleware.js";
import { PRICING_DATA } from "./tools/pricing.js";
import { getDashboardData } from "./analytics/queries.js";
import { PANEL_HTML } from "./analytics/panel.js";
import { checkUsageAlerts } from "./alerts/usage-alerts.js";
import { checkSurfaceDigest } from "./alerts/surface-digest.js";
import { looksLikeApiKey, issueKey, revokeKey, accountExists, accountAddress } from "./fiat/keys.js";
import { verifyPolarSignature, getOrCreateAccountByEmail, creditOrder } from "./fiat/polar.js";
import { writeEvent } from "./analytics/logger.js";

export interface Env {
  // Fase 21.1 — Workers Static Assets binding for the public website
  // (site/dist, built from site/). Cloudflare serves matching static files
  // before this fetch() ever runs; ASSETS.fetch() here is only the fallback
  // for paths with no static match (renders the Astro 404 page).
  ASSETS: Fetcher;

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

  // Fase 24.4 — read-only token for GET /reports/analytics (monthly Claude
  // review routine; separate from ADMIN_API_KEY, which can call paid tools
  // for free). Set via: wrangler secret put ANALYTICS_READ_TOKEN
  ANALYTICS_READ_TOKEN?: string;

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

  // Fiat rail (Fase 17) — Polar (Merchant of Record) checkout + webhook.
  // Secrets (set via: wrangler secret put POLAR_ACCESS_TOKEN / POLAR_WEBHOOK_SECRET).
  POLAR_ACCESS_TOKEN?: string;
  POLAR_WEBHOOK_SECRET?: string;
  // Product id for the "ToolSnap Credits" pay-what-you-want product (var, not secret).
  POLAR_PRODUCT_ID?: string;
  // "sandbox" (sandbox-api.polar.sh) or unset/"production" (api.polar.sh).
  POLAR_ENV?: string;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Api-Key, Mcp-Session-Id, Mcp-Protocol-Version, X-Admin-Key, X-ToolSnap-Internal",
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

    // MCP endpoint. Also accepts POST /mcp/<sk_...> for clients that can't
    // send custom headers (Fase 17 — fiat API key embedded in the URL).
    const mcpKeyInPath = url.pathname.match(/^\/mcp\/(sk_[A-Za-z0-9_]+)$/);
    if (method === "POST" && (url.pathname === "/mcp" || mcpKeyInPath)) {
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

      // API key: header wins over URL if both are present. x-api-key and a
      // bare (non-"Bearer ") Authorization value are both accepted.
      const authHeader = request.headers.get("authorization") ?? "";
      const bearerKey = authHeader.toLowerCase().startsWith("bearer ")
        ? authHeader.slice(7).trim()
        : authHeader.trim();
      const headerKey = request.headers.get("x-api-key") ?? bearerKey;
      const rawApiKey = looksLikeApiKey(headerKey)
        ? headerKey
        : mcpKeyInPath && looksLikeApiKey(mcpKeyInPath[1])
        ? mcpKeyInPath[1]
        : null;

      const { response, status } = await handleMcpRequest(
        body,
        env,
        isAdmin,
        ctx,
        clientUA,
        sessionId,
        isInternal,
        rawApiKey
      );

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
          "Deterministic microtools for AI agents — no account needed for free tools or crypto payment. Free flagship fetch_extract (98.1% median token reduction vs raw HTML, pure parsing, no LLM in the loop) + fetch_html + a wide free utility catalog. Paid: screenshot_url, keyword_research, remove_background (real-COGS tools) — pay per call via x402 USDC on Base, or buy fiat credits with a card at /checkout (API key).",
        mcp_endpoint: "/mcp",
        well_known: "/.well-known/mcp.json",
        pricing: "/.well-known/pricing.json",
        tools: tools.length,
        docs: "https://mcp.toolsnap.app",
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
          `Deterministic, context-efficient microtools for AI agents — free tools and crypto payment need no account. ${tools.length} tools total. Extraction is pure parsing (no LLM in the loop): exact quotes, stable output, zero added inference cost. Free flagships fetch_extract (median 98.1% token reduction, 53,820 → 2,001 tokens, 11 real pages) and fetch_html, plus a wide free utility catalog (CSV/JSON/PDF query, HTML→Markdown, RSS, sitemap, metadata, token count, and more). Paid: screenshot_url, keyword_research, remove_background — real per-call COGS tools, $0.02–$0.04 USDC on Base via x402 (no first-call-free), or fiat credits with a card (API key) at /checkout. Prepaid balances (deposit once, debit off-chain, no per-call gas) work either way.`,
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
          fiat: {
            checkout: "/checkout",
            method: "Card via Polar, no crypto — returns an API key",
            usage: "Authorization: Bearer <key> header, or /mcp/<key> URL for clients without custom headers",
            non_refundable: true,
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
        docs: "https://mcp.toolsnap.app",
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
          `Deterministic, context-efficient microtools for AI agents — free tools need no account. ${tools.length} tools total. Flagship: fetch_extract converts raw HTML to clean text with a median 98.1% token reduction (53,820 → 2,001 tokens, 11 real pages) via pure parsing, no LLM in the loop — free, like fetch_html and most of the catalog. Paid: screenshot_url, keyword_research, remove_background — real per-call COGS, $0.02–$0.04 USDC on Base via x402, or fiat credits with a card. Prepaid: deposit once ($0.50 min), debit off-chain at a discount.`,
        categories: ["developer-tools", "web-scraping", "data-extraction", "paid"],
        transport: "streamable-http",
        homepage: "https://mcp.toolsnap.app",
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

    // Fase 24.4 — read-only analytics for the monthly Claude review routine.
    // Deliberately NOT under /analytics* (that prefix is gated by Cloudflare
    // Access, an interactive SSO login a cloud agent can't complete) — this
    // path does its own token check instead. No PII: payers are wallet
    // addresses/hashes, clients are MCP surface names.
    if (method === "GET" && url.pathname === "/reports/analytics") {
      const token = url.searchParams.get("token");
      if (!env.ANALYTICS_READ_TOKEN || token !== env.ANALYTICS_READ_TOKEN) {
        return jsonResponse({ error: "Invalid or missing token." }, 401);
      }
      try {
        const { getWeeklySurfaceDigest } = await import("./analytics/queries.js");
        const [dashboard, weeklyDigest] = await Promise.all([
          getDashboardData(env.PREPAID_DB, false),
          getWeeklySurfaceDigest(env.PREPAID_DB),
        ]);
        return jsonResponse({ dashboard, weekly_digest: weeklyDigest });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResponse({ error: message }, 502);
      }
    }

    // -----------------------------------------------------------------------
    // Fiat rail — the Polar webhook stays here (sole crediting source);
    // checkout/key UX lives on portal.toolsnap.app since F21.2.
    // -----------------------------------------------------------------------

    // F21.2: the fiat purchase flow moved to portal.toolsnap.app. Permanent
    // redirects preserve the query string so in-flight Polar success_urls
    // (…/welcome?checkout_id=…) keep working — the portal's /welcome reads the
    // same checkout_claims table, so claim idempotency carries over unchanged.
    if (
      method === "GET" &&
      (url.pathname === "/checkout" || url.pathname === "/checkout/start" || url.pathname === "/welcome")
    ) {
      return withCors(
        new Response(null, {
          status: 301,
          headers: { Location: `https://portal.toolsnap.app${url.pathname}${url.search}` },
        })
      );
    }

    // POST /webhooks/polar — the SOLE source of crediting for the fiat rail.
    // Verifies the Standard Webhooks signature, then idempotently credits
    // order.paid events (polar_orders PK on order_id guards against replay).
    if (method === "POST" && url.pathname === "/webhooks/polar") {
      const rawBody = await request.text();
      const verified = await verifyPolarSignature(rawBody, request.headers, env.POLAR_WEBHOOK_SECRET ?? "");
      if (!verified) return jsonResponse({ error: "Invalid webhook signature" }, 401);

      let payload: { type?: string; data?: Record<string, unknown> };
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return jsonResponse({ error: "Invalid JSON" }, 400);
      }

      if (payload.type !== "order.paid" || !payload.data) {
        return jsonResponse({ ok: true, ignored: payload.type ?? "unknown" });
      }

      const data = payload.data;
      const orderId = String(data.id ?? "");
      const totalAmountCents = Number(data.total_amount ?? data.amount ?? 0);
      const metadata = (data.metadata ?? {}) as Record<string, unknown>;
      const metaAccountId = typeof metadata.account_id === "string" ? metadata.account_id : null;
      const customer = (data.customer ?? {}) as Record<string, unknown>;
      const email =
        (typeof data.customer_email === "string" && data.customer_email) ||
        (typeof customer.email === "string" && customer.email) ||
        null;
      const customerId = typeof data.customer_id === "string" ? data.customer_id : undefined;

      if (!orderId || !Number.isFinite(totalAmountCents) || totalAmountCents <= 0) {
        writeEvent(env, {
          toolName: "fiat_webhook",
          paymentType: "fiat_deposit_failed",
          payer: "anon",
          revenueUsdc: 0,
          latencyMs: 0,
          detail: `malformed order.paid payload (order_id=${orderId})`,
          internal: false,
        }, ctx);
        return jsonResponse({ ok: false, error: "malformed payload" }, 200);
      }

      try {
        const accountId =
          metaAccountId && (await accountExists(env.PREPAID_DB, metaAccountId))
            ? metaAccountId
            : email
            ? await getOrCreateAccountByEmail(env.PREPAID_DB, email, customerId)
            : null;
        if (!accountId) {
          throw new Error(`No account_id in metadata and no customer email (order ${orderId})`);
        }
        const amountMicro = BigInt(Math.round(totalAmountCents)) * 10_000n; // cents -> micro-USD
        const result = await creditOrder(env.PREPAID_DB, { orderId, amountMicro, accountId });
        writeEvent(env, {
          toolName: "fiat_webhook",
          paymentType: "fiat_deposit_success",
          payer: `account:${accountId}`,
          revenueUsdc: result.credited ? Number(amountMicro) / 1_000_000 : 0,
          latencyMs: 0,
          detail: result.credited ? undefined : "replay (already credited)",
          internal: false,
        }, ctx);
        return jsonResponse({ ok: true, credited: result.credited });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeEvent(env, {
          toolName: "fiat_webhook",
          paymentType: "fiat_deposit_failed",
          payer: "anon",
          revenueUsdc: 0,
          latencyMs: 0,
          detail: message,
          internal: false,
        }, ctx);
        return jsonResponse({ ok: false, error: message }, 200);
      }
    }

    // /terms, /privacy, /refunds are now served as static pages by the
    // Astro site (Fase 21.1) — Cloudflare serves those files before this
    // Worker ever runs, so no route is needed here anymore.

    // Admin-only key management (pre-portal). Same x-admin-key gate as /mcp.
    if (method === "POST" && (url.pathname === "/admin/keys/issue" || url.pathname === "/admin/keys/revoke")) {
      const adminKey = request.headers.get("x-admin-key");
      if (!env.ADMIN_API_KEY || adminKey !== env.ADMIN_API_KEY) {
        return jsonResponse({ error: "Unauthorized" }, 401);
      }
      let payload: Record<string, unknown>;
      try {
        payload = await request.json();
      } catch {
        return jsonResponse({ error: "Invalid JSON body" }, 400);
      }

      if (url.pathname === "/admin/keys/issue") {
        const email = typeof payload.email === "string" ? payload.email.trim() : "";
        if (!email) return jsonResponse({ error: "email is required" }, 400);
        const accountId = await getOrCreateAccountByEmail(env.PREPAID_DB, email);
        const { keyId, rawKey } = await issueKey(env.PREPAID_DB, accountId, env);
        return jsonResponse({ account_id: accountId, key_id: keyId, raw_key: rawKey });
      }

      const keyId = typeof payload.key_id === "string" ? payload.key_id.trim() : "";
      if (!keyId) return jsonResponse({ error: "key_id is required" }, 400);
      const revoked = await revokeKey(env.PREPAID_DB, keyId);
      return jsonResponse({ revoked });
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

    // Fase 21.1 — no API route matched. For GET requests, fall back to the
    // Astro site's 404 page (env.ASSETS.fetch resolves unmatched paths to
    // site/dist/404.html per not_found_handling in wrangler.jsonc); anything
    // else (POST/PUT/... on an unknown path) gets the plain JSON 404.
    if (method === "GET") {
      const assetResponse = await env.ASSETS.fetch(request);
      return withCors(assetResponse);
    }
    return jsonResponse({ error: "Not found" }, 404);
  },

  // Cron Trigger (daily) — usage alerts for COGS tools (screenshot_url quota)
  // + weekly surface digest (Fase 24.3, Mondays only).
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      checkUsageAlerts(env).catch((err) =>
        console.error("usage-alerts cron failed:", err instanceof Error ? err.message : err)
      )
    );
    ctx.waitUntil(
      checkSurfaceDigest(env).catch((err) =>
        console.error("surface-digest cron failed:", err instanceof Error ? err.message : err)
      )
    );
  },
};
